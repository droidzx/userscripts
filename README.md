# userscripts

自用油猴脚本。

## mihomo-dot.user.js

“Mihomo 监控”在网页角落按列表显示当前页面使用的所有最终出口，整个列表可拖动。

- 每个最终出口单独一行，例如 `xswl-台湾 01`、`lc-hkg香港 08`
- 相同最终出口自动去重，多条线路保持 Mihomo 连接表中的顺序
- 线路一直存在就持续显示；消失后变淡保留约 5 秒再移除
- 没有任何线路时，整个列表自动隐藏
- 不显示完整代理链、域名和实时网速

- 数据来自 mihomo 的 `/connections` 接口，按本机 IP 过滤，只显示当前设备的连接
- 本机设备由脚本自动识别，界面不显示本机 IP；识别失效时会自动重新识别
- 安装 / 更新地址：`https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js`

脚本里的 API 地址与 secret 仅在本地局域网内可达。
