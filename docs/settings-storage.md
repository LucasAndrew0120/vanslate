# 设置与存储

## 设置来源

Vanslate 使用 `chrome.storage.local` 保存设置和缓存。扩展不运营中转服务器，不会把设置上传到作者服务器。

主要设置包括：

- 通用模型：`baseUrl`、`apiKey`、`models`、`activeModel`。
- 语言：源语言、目标语言和界面语言。
- 页面处理：系统提示词、用户提示词、渲染模式（译文覆盖原文 / 行内双语 / 块级双语）、译文 CSS。
- 跳过翻译规则：`skipRules.enabled` 和 `skipRules.patterns`，用于在本地跳过数字、版本号、链接、路径、代码符号等高置信无需翻译的短文本。
- 自动翻译规则：URL 通配符或正则。
- 术语表：`source => target`。
- 悬浮工具：一直显示、不显示、右上角悬停显示。
- 划词工具：名称、启用状态、提示词、模型继承/覆盖。

## 默认值合并

`BrowserSettingsRepository` 读取存储后会合并 `DEFAULT_SETTINGS`。这样新增字段不会导致旧用户设置页崩溃，也方便后续迁移。

## 敏感信息

API Key 只存在本地扩展存储中。写入 `chrome.storage.local` 前会通过 Web Crypto AES-GCM 加密，读取设置时由扩展本地解密。密钥材料保存在同一个本地扩展存储命名空间下的 `vv_vanslate_cryptoSecret`，用于降低明文暴露风险；它不是服务端密钥，也不会上传到作者服务器。

设置页只显示 API Key 的前 8 位和后 4 位。用户聚焦输入框后可以输入新值；不输入则保持原值。划词工具单独配置的 API Key 也使用同一套加密和脱敏展示逻辑。

代码和文档不应提交真实 API Key、真实域名私有配置、个人素材源文件或未压缩设计源文件。

对应 `.gitignore` 已覆盖：

- 本地历史素材和生成源文件。
- `*.pem`、`.env*`、临时测试输出。
- 历史备份 HTML 和未用于发布的图片源文件。

## 缓存策略

译文缓存保存在 `translationCache` 中，按更新时间淘汰。缓存只用于减少重复请求，不应作为永久数据层。

清空缓存入口：

- popup 底部“清除”。
- options 设置页“清空缓存”。

## 迁移策略

新增设置时：

1. 在默认设置中加入字段。
2. 在 repository 归一化读取结果。
3. 在 UI 中展示字段说明。
4. 为核心行为补单元测试。
5. 如果字段影响模型输出，加入缓存 key。

## 思考 / 推理参数

`reasoning` 是结构化的设置对象，用于控制 Chat Completions 请求是否携带思考参数：

```json
{
  "enabled": false,
  "effort": "auto",
  "dialect": "auto",
  "applyToTranslation": false
}
```

- `enabled`：是否开启思考。默认 `false`。
- `effort`：`auto | minimal | low | medium | high`。`auto` 只发送方言开关，不写 `reasoning_effort`。
- `dialect`：`auto | openai | thinking | enable_thinking`。`auto` 按 Base URL 和模型名识别：DeepSeek / GLM 走 `thinking.type`，Qwen / DashScope / SiliconFlow 走 `enable_thinking`，其余走 OpenAI 的 `reasoning_effort`。
- `applyToTranslation`：全文翻译是否也使用思考。默认 `false`，因为全文翻译逐批调用，思考会显著增加耗时和费用。

行为约定：

- 请求体只在调用方明确传入 `reasoning` 时才会附加思考字段，未配置时保持 `model` + `temperature` + `messages` 三个字段不变。
- 关闭思考时，对已识别的 thinking 方言（DeepSeek、GLM、Qwen）主动发送关闭参数，因为这些接口默认开启思考。
- 未识别的 OpenAI 兼容接口不发送任何额外字段，避免严格实现返回 400。
- 如果网关仍以 400/422 拒绝思考字段（错误信息中包含 `thinking`、`enable_thinking` 或 `reasoning_effort`），客户端会自动去掉这些字段重试一次。
- 划词工具可用 `reasoningMode`（`inherit | on | off`）覆盖全局开关。
- 只有当 `enabled && applyToTranslation` 时，思考配置才参与缓存 key，升级后已有翻译缓存继续有效。

## 跳过翻译规则

`skipRules` 是用户可编辑 JSON：

```json
{
  "enabled": true,
  "patterns": ["^https?:\\/\\/\\S+$", "^[vV]?\\d+(?:\\.\\d+){1,4}"]
}
```

规则只用于“整段跳过”。默认规则覆盖纯数字、数字单位、版本号、发布标签、日期时间、URL、邮箱、路径、文件名、命令、配置值、哈希/UUID/API token、快捷键、尺寸比例、HTML/CSS/JS 选择器和少量常见型号。不要把宽泛自然语言正则加入这里，否则会导致正文被误跳过。
