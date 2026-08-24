# userscripts

自用油猴脚本。

## mihomo-dot.user.js

“Mihomo 监控”会在网页右下角显示一个小圆点，用于查看当前页面请求的全部域名、命中的 Mihomo 规则和实时流量。鼠标移上去展开暗色紧凑面板，可在标题栏固定，圆点可拖动。

- 面板顶部显示当前页面的实时上传、下载速度；域名右侧显示该域名当前活跃连接已下载的数据量
- 浏览器已观察到但没有 Mihomo 连接记录的域名归入“直连”
- 油猴脚本不是抓包工具，顶部网速只统计 Mihomo 连接，无法统计 ROS 上的真实流量

- 数据来自 mihomo 的 `/connections` 接口，按本机 IP 过滤，只显示当前设备的连接
- 活动颜色：灰 = 当前无流量，绿 = 正在传输；右下角圆点红色表示 Mihomo 连接失败
- 本机设备由脚本自动识别，界面不显示本机 IP；识别失效时会自动重新识别
- 安装 / 更新地址：`https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js`

脚本里的 API 地址与 secret 仅在本地局域网内可达。
