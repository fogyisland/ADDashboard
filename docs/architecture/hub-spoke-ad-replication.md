# Hub-Spoke 分层复制架构设计

> **适用场景**：企业 AD 域环境扩展至 **40 台 DC / 20 个物理站点**及以上
> **作者**：AD 架构师建议 + 项目落地
> **日期**：2026-08-30（R68）
> **目标**：用 Hub-Spoke 分层架构替换 40×40 全矩阵展开，避免无意义的交叉复制链路堆积。

---

## 1. 核心问题 — 为什么不画 N×N 全矩阵

当 AD 站点从 4 增长到 20，KCC 自动生成的复制拓扑会"自然扩散"：

```
                    站点数量增长
                        ↓
        KCC 默认行为：每对站点之间自动建立复制链路
                        ↓
        复制链路数量  = N × (N-1) ≈ O(N²)
                        ↓
        20 站点 ≈ 380 条潜在链路（其中大半是 KCC 默认拉的"穿透型"链路）
        40 站点 ≈ 1560 条潜在链路
                        ↓
        后果 1：监控指标被海量"健康但无用"的链路淹没
        后果 2：KCC 反复重算，增大 CPU 开销
        后果 3：故障定位困难 — 一条核心链路断了，全网重路由
        后果 4：跨区域 WAN 带宽被不必要地占用
```

**用一句话总结**：默认拓扑让所有站点"互相对等"，但企业 AD 实际上一定有"核心 vs 分支"的层级。Hub-Spoke 就是把这个层级**显式建模**出来。

---

## 2. 三层架构模型

把 20 个站点划分成三层：

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1 — 核心层 (Hub 层)                                   │
│  ─────────────────────────────────────────────────────────  │
│  数量:   2 ~ 4 个站点 (建议 2~3 主 + 1 DR)                  │
│  拓扑:   Hub ↔ Hub 全互联 (mesh) 或主备 (主备 + witness)    │
│  复制:   双向 / 高频率 (15 秒) / 最低 site-link cost        │
│  DC:    每个 Hub 站点 ≥ 2 台 DC (避免单点)                  │
│  责任:   域命名主机 / Schema 主 / RID 主 / PDC 模拟主        │
└─────────────────────────────────────────────────────────────┘
                          ↑↑↑
                          │ (单向 或 双向，单向更常见)
                          │ 复制频率较低 (5~15 分钟)
                          │ site-link cost 较高
                          ↓↓↓
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2 — 分支层 (Spoke 层)                                 │
│  ─────────────────────────────────────────────────────────  │
│  数量:   16 ~ 18 个站点                                     │
│  拓扑:   Spoke → ONE Hub (就近) — 严格 1:N                   │
│  复制:   单向 / 较长间隔 (5~15 分钟)                         │
│  关键:   Spoke 之间不直接建立复制链路！                       │
│  DC:     每个 Spoke 站点 1~2 台 DC                           │
│  责任:   站点内认证 + GC (一般通用目录服务)                  │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ 站点内复制
                          │ 标准模板：环形 或 全互联
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3 — 站点内层 (Intra-site)                             │
│  ─────────────────────────────────────────────────────────  │
│  拓扑:   站点内所有 DC 之间互相复制 (环或全互联)             │
│  频率:   最高 (15 秒) — 站点内通常 LAN                       │
│  cost:   不计 cost (默认)                                   │
│  关键:   统一采用一个模板，不要每个站点各搞一套               │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 关键原则 — Spoke 间禁止直连

```
       ❌ 反对：Spoke A ←→ Spoke B (穿透型)
                          ↓ KCC 会拉这种
       ┌──────┐          ┌──────┐
       │ Hub1 │ ←──────→ │ Hub2 │
       └──┬───┘          └──┬───┘
          │                 │
       ┌──┴───┐          ┌──┴───┐
       │Spoke │ ←─禁止─→ │Spoke │   ← 这条不该存在
       │  A   │          │  B   │
       └──────┘          └──────┘

       ✅ 正确：所有 Spoke 复制都经过 Hub
       ┌──────┐          ┌──────┐
       │ Hub1 │ ←──────→ │ Hub2 │
       └──┬───┘          └──┬───┘
          │                 │
       ┌──┴───┐          ┌──┴───┐
       │Spoke │          │Spoke │
       │  A   │          │  B   │
       └──────┘          └──────┘
        各自只连 Hub，从不直接对话
```

**实施手段**：
1. 在 Spoke 站点的 site link 配置中，**只填一条**通向其归属 Hub 的 link
2. 用 site-link cost 把跨区 Spoke-to-Spoke 的 cost 调到极高位（KCC 会主动避免）
3. KCC 在 Spoke 站点禁用，由人工维护 (`Disable-KccOnSite` 或 `repadmin /options`)

---

## 3. Site Link 成本规划

Site link cost 决定 KCC 优先选择哪条路径：

### 3.1 推荐 cost 模板

| 链路类型 | 推荐 cost | 说明 |
|---------|-----------|------|
| Hub ↔ Hub (同区域) | 100 | 默认低开销，KCC 优先 |
| Hub ↔ Hub (跨区域/WAN) | 200~300 | 可接受，但 KCC 会优先走 LAN |
| Spoke → Hub (就近平层) | 50 | 比 Hub-Hub 还低！让 KCC 偏好 Spoke 优先复制 |
| Spoke → Hub (跨区域) | 400~500 | 兜底，避免 |
| Spoke → Spoke (禁止) | 800~1000 | KCC 会主动避开 |

**关键**：Spoke→Hub 的 cost 要**比 Hub↔Hub 还低**——因为站点内复制更频繁，KCC 应该把 Spoke 当作"叶子节点"，不要让它绕道。

### 3.2 复制频率规划

| 链路 | 建议频率 (Replication Interval) | 理由 |
|------|-------------------------------|------|
| 站点内 (Intra-site) | 15 秒 | LAN，零延迟，应该最快 |
| Hub ↔ Hub | 15~60 秒 | DC 之间改动频繁 |
| Spoke → Hub | 5~15 分钟 | 分支站点变化少，避免 WAN 抖动 |

---

## 4. KCC 行为优化

KCC（Knowledge Consistency Checker）默认会**每 15 分钟**重算整个站点的复制拓扑。在大型环境中：

| 策略 | PowerShell 操作 | 何时用 |
|------|----------------|-------|
| 禁用 Spoke 的 KCC | `Get-ADObejct (Get-ADDomainController -Discover).NTDSSettingsObjectDN \| Set-ADObject -Add @{options='1'}` | Hub 数量稳定、Spoke 拓扑固定的成熟环境 |
| 间歇 KCC (Inter-Site Topology Generator = ISTG) | 由 Hub 站点负责跨区计算 | 默认行为，无需特殊配置 |
| 强制 ISTG 选举 | `Get-ADReplicationSite -Identity Hub1 \| Set-ADReplicationSite -AutomaticInterSiteTopologyGenerationEnabled $false` | DR 场景下指定 Hub 专责 |

**推荐**：Hub 站点保留 KCC 全功能；Spoke 站点禁用 KCC（`Disable-KccOnSite`），由 Hub 的 ISTG 统一规划跨区复制。

---

## 5. 监控视图设计原则（落到 R68 前端）

N×N 全矩阵在大型环境里**不可读**。R68 把监控矩阵分成三层：

```
+-------------------------------------------------------------------+
| 站点矩阵 — Hub-Spoke 分层视图                                       |
| 4 中心 / 16 分支 / 40 DC                                          |
+-------------------------------------------------------------------+
| Legend: 绿=OK 黄=部分失败 红=断开 灰=无链路 (designed absence) |
+-------------------------------------------------------------------+
| ▼ Panel 1 — 核心层 Hub ↔ Hub [4×4 = 16 cells]                    |
|   核心站点两两之间的复制。每个 cell 都重要，应该是全绿。           |
+-------------------------------------------------------------------+
| ▼ Panel 2 — 分支层 Spoke → Hub [16×4 = 64 cells]                  |
|   行=分支站点，列=核心站点。                                       |
|   健康预期：每行只有 1 个 cell 是绿色（连自己的归属 Hub）            |
|   其他 3 个 cell 应该是灰色（designed absence — 设计上就不该连）    |
+-------------------------------------------------------------------+
| ▼ Panel 3 — 钻取层 每站 DC 详情 [collapsed by default]            |
|   点击展开。显示该站点所有 DC + 完整入站伙伴表                     |
+-------------------------------------------------------------------+
```

**为什么这样设计**：
- **Panel 1 + Panel 2 总共 80 个 cells**，覆盖 20 个站点的健康度，比 400 cells 的 N×N 矩阵信息密度高 5 倍
- **灰色不再是"异常"而是"设计预期"** — 消除误报警
- **Panel 3 是按需展开**，operator 只在定位故障时钻进去
- **规模不变性**：4 站点或 40 站点，Panel 1+2 总数都在 O(N_hub² + N_spoke × N_hub) 量级，比 N² 友好得多

---

## 6. PowerShell 自动化脚本清单

| 脚本 | 路径 | 功能 |
|------|------|------|
| KCC Hub-Spoke 分析器 | `scripts/kcc-hub-spoke-analyzer.ps1` | 只读分析当前 AD 拓扑，输出 site-link cost 推荐表 + KCC 行为清单 + 合规报告 |

### 6.1 kcc-hub-spoke-analyzer.ps1 设计要点

**只读，不修改 AD**：analyzer 只产出"建议清单"，operator 确认后由 PowerShell 手动/单独脚本应用。

**输出三块**：
1. **当前拓扑摘要**：sites 数量、site links 数量、跨区 site links、按 cost 分组
2. **Site-link cost 推荐表**：对每个 site link 输出"当前 cost / 推荐 cost / 差距 / 原因"
3. **Hub-Spoke 合规报告**：标记所有"Spoke → Spoke"意外链路（应是 KCC 自动拉的穿透型）

**运行方式**：
```powershell
# 在任意域控上运行（需要 Domain Admin 权限）
pwsh -File scripts/kcc-hub-spoke-analyzer.ps1
# 输出: 控制台 markdown 表 + 写入 logs/hub-spoke-report.md
```

---

## 7. 实施路线图（操作清单）

按推荐顺序：

1. **第一阶段 — 拓扑梳理**
   - [ ] 运行 `kcc-hub-spoke-analyzer.ps1`，生成现状报告
   - [ ] 人工圈定 Hub 站点（建议 2~3 个），在 AD Sites and Services 中标记
   - [ ] 在本项目的 `ad_sites` 表中维护 `is_hub` 字段（每个 Hub 站点 = 1）

2. **第二阶段 — Site-link 成本调整**
   - [ ] 按"3.1 推荐 cost 模板"调整每个 site link 的 cost
   - [ ] Spoke → Hub 就近：cost = 50
   - [ ] Spoke → Spoke 禁止：cost = 1000

3. **第三阶段 — KCC 行为收敛**
   - [ ] Hub 站点保持默认（启用 KCC + ISTG 选举）
   - [ ] Spoke 站点禁用 KCC（`Disable-KccOnSite` 或修改 NTDS Settings options）
   - [ ] 验证：跑 `repadmin /showrepl` 应该看不到 spoke-to-spoke 复制

4. **第四阶段 — 监控对齐**
   - [ ] R68 前端矩阵上线后，对照 R68 视图验收：
     - Panel 1 核心层：全部绿色
     - Panel 2 分支层：每行 1 绿 3 灰（designed absence）
     - Panel 3 钻取层：每个 Spoke 站点只显示一条到 Hub 的入站

5. **第五阶段 — 文档归档**
   - [ ] 把 site link 配置截图归档到 `docs/architecture/hub-spoke-deployment-YYYYMMDD.md`
   - [ ] 把 `kcc-hub-spoke-analyzer.ps1` 加入定期巡检（每周一次）

---

## 8. 容量预估 — 40 DC / 20 站点

按推荐架构估算：

| 指标 | 数值 | 对比全矩阵 |
|------|------|------------|
| 跨区 site links | 2×3 (Hub-Hub) + 16×1 (Spoke-Hub) = **22** | 全矩阵 = 380 |
| KCC 重算规模 | 仅 2~3 个 Hub | 全部 20 站点 |
| 监控 cells（Panel 1+2） | 16 + 64 = **80** | 全矩阵 = 400 |
| 故障定位时间 | < 1 分钟（看 Panel 1/2） | 5+ 分钟（在 N×N 里翻找） |
| WAN 带宽占用 | 仅 Spoke→Hub 的单向复制 | 多向穿透链路 |

**结论**：从 O(N²) 降到 O(N_hub² + N_spoke × N_hub)，大规模环境下可读性 + 可维护性 + 可监控性都有质的提升。

---

## 9. 参考与延伸阅读

- Microsoft Docs: [Designing the Site Topology](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/plan/designing-the-site-topology)
- Microsoft Docs: [How the KCC Works](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/plan/how-the-kcc-works)
- 实战参考：《Active Directory: Designing, Deploying, and Running Active Directory Fifth Edition》Chapter 13: Site Topology
