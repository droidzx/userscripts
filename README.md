# userscripts

自用油猴脚本。

## mihomo-dot.user.js

“Mihomo 监控”会在网页右下角显示一个小圆点，用于查看当前页面请求命中的规则、节点和实时流量。鼠标移上去展开详情，可在面板标题栏固定，圆点可拖动。

- 面板顶部显示当前页面的实时上传、下载速度；域名右侧显示该域名当前活跃连接已下载的数据量

- 数据来自 mihomo 的 `/connections` 接口，按本机 IP 过滤，只显示当前设备的连接
- 圆点颜色：绿 = 已连接，蓝 = 传输中，红 = 连不上，灰 = 待机
- 本机设备由脚本自动识别，界面不显示本机 IP；识别失效时会自动重新识别
- 安装 / 更新地址：`https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js`

脚本里的 API 地址与 secret 仅在本地局域网内可达。
