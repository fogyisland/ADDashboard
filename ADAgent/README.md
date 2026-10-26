# AD Replication Agent 鈥?Release Package

瀹屾暣鐨?agent 瀹㈡埛绔畨瑁呭寘. 鐩存帴鎷胯蛋鏀惧埌鐩爣鏈哄櫒 `C:\agentInstall\`, 杩愯:

```powershell
cd C:\release\agentInstall
.\install-agent.ps1 -ComputerName . -CenterUrl "http://your-centre:8080" -AgentToken "<token>" -AgentType ad
```

## 鐩綍甯冨眬

```
agentInstall\
  install-agent.ps1         WinRM/鏈湴瀹夎鍏ュ彛
  uninstall-agent.ps1       鍗歌浇鍏ュ彛
  start.ps1                 璋冭瘯鐢ㄥ惎鍔?(鍓嶅彴杩愯)
  Register-ADDashboardAgent.ps1   NSSM install / sc recovery 缁熶竴鍏ュ彛
  appsettings.example.json   閰嶇疆妯℃澘 (涓嶅惈 token)
  common\                   Logger/Service/NSSM 鍏叡妯″潡
  nssm\                     NSSM 浜岃繘鍒?(win32)
  node\                     Node.js 20 LTS portable
  agent\                    瀹為檯瀹夎鐩爣 鈥?install-agent 鎶婂畠 staging 鍒?<InstallPath>\
    src\                    ESM JS 婧愮爜 (R93.5 / R93.7 / package-runner env)
    scripts\                PowerShell 鑴氭湰
    data\packages\          7 涓?collect.ps1 鍖?    package.json
```

## 瀹夎娴佺▼

1. 鎷疯礉鏁翠釜鐩綍鍒扮洰鏍囨満 `C:\agentInstall\`
2. `cd C:\agentInstall`
3. `.\install-agent.ps1 -ComputerName . -CenterUrl <url> -AgentToken <token> -AgentType ad`
4. install-agent 浼?
   - 鎷疯礉 agent\ 鍐呭鍒?InstallPath
   - 鎷疯礉 node\ 鍒?InstallPath\node\
   - `npm install --omit=dev` 閲嶅缓 node_modules
   - 鍐?appsettings.json
   - NSSM install ADReplicationAgent + 12 鍙傛暟璁剧疆
   - sc.exe failure recovery
   - Start-Service

## R93.x changelog

R93.5 鈥?packages-report 绔彛閿欎綅 (8080 鈫?8082)
R93.7 鈥?reschedule() 鏀逛负 set-difference (KEEP/UPDATE/ADD/REMOVE)
        涓嶅啀鏃犲樊鍒?clearInterval 閲嶅缓, 鑰?timer 鏃堕棿绱淇濈暀
        900s / 3600s 鍖?(ad_lockout_list / ad_domain_consistency 绛? 鐜板湪鎸?cadence 姝ｅ父 fire

package-runner.js 鈥?env 瀛楁閫忎紶缁?spawn 鐨?PowerShell
        collect.ps1 璇?$env:CENTER_URL 鍚庤兘姝ｅ父 POST 8081 鎷?peers

## 宸茬煡闂

- ad_partner_ports_probe 鍦?LocalSystem 涓?collect.ps1 鎷夸笉鍒?peers
  - 涓湡 fix: package-manager.js.runOne() 璋?_runPackageScript 鏃堕€忎紶 env
