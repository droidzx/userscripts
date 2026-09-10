# userscripts

自用油猴脚本。

## mihomo-dot.user.js

“Mihomo 监控”在网页角落显示当前页面使用的最终出口，点击后展开完整代理链。标签可拖动，再次点击即收起。

- 收起时只显示最终节点，例如 `xswl-台湾 03`
- 展开后按“应用策略 › 中间策略组 › 最终节点”的方向显示完整代理链，例如 `YouTube › 备用优先 › 备用出口 › xswl-台湾 03`
- 同时存在多条代理链时按活跃状态和最近出现时间排列
- 连接结束后保留约 10 秒，然后整个标签和面板自动消失
- 不显示域名和实时网速

- 数据来自 mihomo 的 `/connections` 接口，按本机 IP 过滤，只显示当前设备的连接
- 本机设备由脚本自动识别，界面不显示本机 IP；识别失效时会自动重新识别
- 安装 / 更新地址：`https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js`

脚本里的 API 地址与 secret 仅在本地局域网内可达。
