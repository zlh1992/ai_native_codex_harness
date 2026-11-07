# Panelize 文本适配器

来源：[Manho/Panelize](https://github.com/Manho/Panelize/tree/fb9cc70d4c38bf13a5ebb7bf4b76abad107ce2c1)，版本 2.0.1，复用提交 fb9cc70d4c38bf13a5ebb7bf4b76abad107ce2c1。

`text-injection-all-providers.js` 仅清理上游行尾空白，逻辑保持不变。原始 SHA256 为 f5841e1c3c7fd3e020211de3f6c11764e9bca5af187db01b59d53be4b3f435cc；仓库规范化后 SHA256 为 15e0145ba1bf734246af4f5496fe298f72cce8bcc3358eaf7c07926336433b53，许可证见 [LICENSE](LICENSE)。从既有 panelize-multi-agent skill 固定快照复制。

Portal 只使用其中的 provider 检测、编辑框查找、文本填入和发送函数。服务端包装器移除扩展消息监听/宽度报告入口，返回闭包函数供受控浏览器调用；不接收网页 postMessage 指令，不复用扩展 cookies 权限，不另写供应商 DOM 选择器。浏览器标签和接管复用 Portal；完成判断由 root 阅读真实页面，发送函数不提供答案完成保证。
