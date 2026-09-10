# 项目说明

## 项目用途

- 这是自用 Tampermonkey 脚本仓库，当前主脚本为 `mihomo-dot.user.js`。
- 脚本在网页角落列出 Mihomo 最终出口，按当前设备和当前页面域名筛选 `/connections` 数据。
- `README.md` 面向使用者，只记录功能、限制和安装地址；不在其中写入 API secret、订阅地址或其他敏感信息。

## 现有行为

- 通过 Performance API 收集当前页面访问过的 HTTP(S) 和 WebSocket 域名。
- 通过 Tampermonkey 的 `GM_xmlhttpRequest` 每秒轮询 Mihomo API，后台标签页不发起请求。
- 自动识别并记住当前设备的源 IP，仅显示该设备的连接；识别值失效后重新投票学习。
- 界面只按顺序列出去重后的 `chains[0]` 最终节点，不显示完整代理链、域名和网速。
- 新连接出现或连接的上传/下载计数继续增长时刷新线路活跃时间；连续 5 秒无新流量后移除，没有任何线路后整个界面自动隐藏。
- 出口列表支持拖动和 SPA 换页重置；用户位置和已识别的源 IP 由 `GM_getValue` / `GM_setValue` 保存。

## 修改原则

- 优先在现有单文件结构中小范围修改；除非脚本明显失控，不引入构建工具、框架或不必要的依赖。
- 保持脚本可由 Tampermonkey 直接安装，并兼容普通网页、SPA、Shadow DOM 样式隔离及页面可见性切换。
- 修改 API 主机时，同步检查 UserScript 头部的 `@connect`；修改文件名或发布地址时，同步检查 `@downloadURL`、`@updateURL` 和 `README.md`。
- 功能或修复发布时更新 UserScript 头部的 `@version`；用户可见行为改变时同步更新 `README.md`。
- 不将 secret、Token 或其他凭据新增到文档、日志或测试输出中；如需调试鉴权，只报告状态码和错误类型。
- 保留用户已保存的 Tampermonkey 配置键兼容性；如必须改名，先实现旧键迁移。

## 验证要求

- 至少执行 JavaScript 语法检查，确认 UserScript 头部元数据完整。
- 涉及界面或连接逻辑时，在 Tampermonkey 中手动检查：出口列表显示/隐藏、多线路顺序和去重、拖动、5 秒保留、失败重试、切换页面和切换标签页。
- 验证只应使用自己可控的 Mihomo 实例，不把内网地址或鉴权信息贴到公开问题、截图或日志。

## Git 与发布

- 正式仓库为 `https://github.com/droidzx/userscripts.git`，默认分支为 `main`。
- 修改后先查看差异并完成必要验证，再提交和推送；不提交临时文件、调试日志或含敏感信息的输出。
