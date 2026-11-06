// PM2 配置文件 —— 宝塔「Node 项目」管理器原生支持本文件。
//
// ⚠️ cwd 必须是 <安装根>/center (即本文件所在目录的 center 子目录), 不能是安装根。
//    原因: center/server.js:851 用 `process.cwd() + '/data/packages'` 决定内置包
//    的落盘位置, center/src/app.js:44 的 express.static(config.staticDir) 里的
//    staticDir "./dist" 同样相对 cwd。cwd 错了, 内置包装错目录、前端 404。
//    本文件放在安装根, __dirname 即安装根, 故 cwd = join(__dirname, 'center')。
//
// ⚠️ 崩溃循环不变式 (R161, 2026-10-25 —— 读 pm2 7.1.1 源码实测, 别凭直觉改):
//
//    pm2 判定一次重启「不稳定」需要同时满足:
//      (a) 子进程存活时长 < min_uptime          (pm2 默认 1000 ms)
//      (b) 本次进程被创建的时间 < min_uptime × max_restarts
//    当 unstable_restarts >= max_restarts 时, pm2 把状态置为 errored 并
//    **永远不再拉起** —— 也就是说 "max_restarts 达到上限" = 服务彻底死掉,
//    不是「重试若干次后放弃保护」。
//
//    本文件 restart_delay = 5000 ms > min_uptime = 1000 ms ⇒ 两次重启之间
//    至少隔 5 秒 ⇒ 子进程要活满 10 秒才算「稳定」⇒ 10 秒窗口里最多塞进
//    2 次不稳定重启 ⇒ **max_restarts = 10 这道阈值在 5 秒延迟下根本够不着**
//    ⇒ 崩溃时无限重启 ⇒ 与 Windows 版 NSSM (AppExit Default Restart,
//    AppRestartDelay 5000) 行为一致。
//
//    ⚠️ 改任何一个数都可能踩雷:
//      · 把 restart_delay 调到 <= min_uptime (例如 500) ⇒ 10 秒窗口能塞
//        20 次 ⇒ 第 10 次就把进程判死 ⇒ 服务永远起不来 (比崩溃循环更糟)。
//      · 把 max_restarts 改成 0 ⇒ **不是**「无限重启」, 0 >= 0 恒真 ⇒
//        第一次退出就 errored ⇒ 服务永远起不来。
//      · 写 Infinity ⇒ JSON.stringify 后变成 null, dump.pm2 里是坏的。
//    要表达「无限重启」, 保持 max_restarts = 10 + restart_delay = 5000 这组
//    数字即可 —— 阈值本来就够不着。
//
// ⚠️ max_memory_restart = 512M: 内存超限也会触发一次重启 (PM2 语义与崩溃
//    重启一致, 且此时进程存活时长 > min_uptime, 不计入「不稳定」计数)。
//    Windows 版 NSSM **没有**内存上限, 这是 Linux 独有的不对称项。
//    512M 是保守值; 若生产实测 RSS 更高 (ps -o rss,pid -p <pm2 pid> 或
//    pm2 monit), 改大它, 改小它没有好处 —— 宁可 OOM 崩一次也不要无限重启。

const path = require('node:path');

const CENTER_DIR = path.join(__dirname, 'center');

module.exports = {
  apps: [
    {
      name: 'ADDashboardCenter',
      script: 'server.js',
      cwd: CENTER_DIR,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,          // 1:1 平行 NSSM AppRestartDelay 5000
      max_memory_restart: '512M',
      kill_timeout: 25000,          // 1:1 平行 NSSM AppStopMethodStop
      listen_timeout: 10000,
      out_file: './logs/pm2-out.log', // 只兜 stdout; 业务日志是 logs/center.*.log
      error_file: './logs/pm2-err.log',
      env: {
        NODE_ENV: 'production',
        // 固定 locale —— 让无参 localeCompare() 的排序与 Windows 版一致。
        // 中心有 12 处 localeCompare 没指定 locale(纯 ASCII 名字无影响,
        // 仅"名字含中文 + LANG 非中文"时顺序会变)。详见 README 第 7 节。
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8'
        // ⚠️ 敏感值一律不落这里: DB 密码 / jwtSecret / agentToken / signature
        //    只存在于 center/appsettings.json(由初始化向导生成)。
        //    R158.95-ext 锁: 0 敏感 KV 进服务注册表。
      }
    }
  ]
};
