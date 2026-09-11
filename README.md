# userscripts

自用油猴脚本。

## mihomo-dot.user.js

“Mihomo 监控”在网页角落按列表显示当前页面使用的所有最终出口，整个列表可拖动。

- 每个最终出口单独一行，例如 `xswl-台湾 01`、`lc-hkg香港 08`
- 相同最终出口自动去重，多条线路保持 Mihomo 连接表中的顺序
- 只显示能确认属于当前页面的连接，避免无域名的 `MATCH` 连接串到其他页面
- 新连接、重新连接或线路持续产生流量时保持显示；连续 5 秒没有新流量后移除
- 没有任何线路时，整个列表自动隐藏
- 不显示完整代理链、域名和实时网速
- 列表使用小字号、紧凑行高和较窄宽度，减少对网页内容的遮挡
- 首次运行会要求输入 Mihomo API Secret；Secret 只保存在当前浏览器的油猴本地存储中

- 数据来自 mihomo 的 `/connections` 接口，按本机 IP 过滤，只显示当前设备的连接
- 本机设备由脚本自动识别，界面不显示本机 IP；识别失效时会自动重新识别
- 安装 / 更新地址：`https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js`

脚本里的 API 地址仅在本地局域网内可达，仓库不保存 API Secret。
