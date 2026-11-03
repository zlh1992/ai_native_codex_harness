# Fast、项目归档与密码

## Fast
老板和员工在工作台选择对话后点击 Fast；开启后下一轮固定使用 GPT-6 Luna、high 推理和 fast 服务等级。再次点击关闭，恢复原模型选择。当前运行不受影响，待发输入在下一轮启动时使用新设置。Fast 不改变 EXECUTE/EDIT 权限。
托管 skill 为 [fast-mode](../portal-skills/fast-mode/SKILL.md)，通过 portal_fast_mode 工具修改当前对话。
微信连接器可在对应用户的已认证会话下调用：
- PATCH /api/chats/:chatId，JSON 字段 fastMode 为 true/false。
- 沿用会话 Cookie、x-csrf-token 和合法 Origin；只有用户自己的有效 chat 可以操作。
- 不应把密码或会话凭据放进模型提示词。
实际模型可用性、额度和加速效果由上游决定；接口保存成功表示偏好已保存，不代表模型请求已经执行。服务等级定义参见 [官方 Fast 文档](https://developers.openai.com/api/docs/guides/fast-mode)。

## 项目
工作台每个可访问项目都有归档/恢复按钮；勾选“显示已归档项目”查看并恢复。归档是项目全局状态，老板驾驶舱会显示“已归档”，不停止任务或撤销共享。
老板驾驶舱仅在自己的项目上显示永久删除。弹窗确认后不可恢复，会清除该项目文件；存在运行、有效共享或保留的撤权工作树时会拒绝，先按错误提示处理。
API：POST /api/projects/:id/archive，JSON 字段 archived 为 true/false。普通 DELETE 仍进入回收站；永久删除需老板 owner 身份、?permanent=1 和 x-confirm-project-id 确认头。

## 员工账号
新建员工仅填写账号即可，使用产品约定的默认初始密码。老板设置自定义密码或重置密码时，需两次明文输入一致。
员工登录工作台后点击“修改密码”，两次明文输入新密码；长度为 12–256 个字符。成功后所有设备退出登录、当前任务中断，需要重新登录。
自助接口为 POST /api/me/password，管理员创建/重置沿用 /api/admin/users；自定义密码字段为 password、passwordConfirmation。确认值不一致会拒绝。
