# userscripts

自用油猴脚本。

## mihomo-dot.user.js

网页右下角一个小圆点，显示当前页面的请求命中了 mihomo 的哪条规则、走的哪个节点、实时流量多少。鼠标移上去展开详情，点一下固定，可拖动。

- 数据来自 mihomo 的 `/connections` 接口，按本机 IP 过滤，只显示当前设备的连接
- 圆点颜色：绿 = 已连接，蓝 = 传输中，红 = 连不上，灰 = 待机
- 本机设备由脚本自动识别，界面不显示本机 IP；识别失效时会自动重新识别
- 安装 / 更新地址：`https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js`

脚本里的 API 地址与 secret 仅在本地局域网内可达。
