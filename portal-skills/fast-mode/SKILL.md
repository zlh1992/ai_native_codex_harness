---
name: fast-mode
description: 用户要求开启或关闭当前 Portal 私有对话的 Fast 模式时使用；供老板、员工工作台及微信接入调用。
---

调用 portal_fast_mode，enabled=true 开启，false 关闭。工具绑定当前用户的当前对话，不接收其他用户或对话 ID。
开启后后续 turn 使用 gpt-6-luna、high reasoning、fast service tier；当前 turn 不变，不重建历史，不改变任务权限或子代理策略。
只有工具成功才能告知设置已保存。不要承诺上游模型可用、实际加速或免费。
微信连接器在已认证用户会话下也可调用 PATCH /api/chats/:chatId，JSON 为 {"fastMode":true} 或 false，沿用 Origin、CSRF 和私有 chat ACL；不得把会话凭据写入提示词。
