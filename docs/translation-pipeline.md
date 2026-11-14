# 页面处理流水线

## 全文翻译流程

```text
用户触发全文翻译
  -> content 扫描可见文本节点
  -> 给待翻译元素追加 loading
  -> background 调用 TranslationService.translateTexts
  -> 逐项跳过/读缓存/调用模型/写缓存
  -> ProgressSink 推送 item-result
  -> content 立即渲染单项结果
  -> ProgressSink 推送整体进度和 token usage
```

## 文本收集

content 侧会跳过：

- `script`、`style`、`noscript`、`code`、`pre`。
- 输入框、文本域、选择框和可编辑区域。
- 已经处理过或正在处理的节点。
- 极短文本、纯符号文本和明显不可读文本。

导航、目录和右侧栏不应被默认排除；只要是用户可见的文本，就应尽量进入处理队列。

单轮采集上限为 `MAX_BLOCKS_PER_PASS`（80）。超出时按优先级排队：

1. 正文块（`H1-H6`、`P`、`LI`、`BLOCKQUOTE`、`DD`、`DT`、`FIGCAPTION`）。
2. 表格与表单文本（`TD`、`TH`、`CAPTION`、`LEGEND`、`LABEL`、`SUMMARY`）。
3. 页面框架（`nav`、`aside`、`header`、`footer`）和其它零散标签。

同一优先级内按 DOM 深度从深到浅处理。段落、列表项、表格单元格内部的 `A`/`SPAN` 不单独入队，交给所在块整体翻译，避免译文插在句子中间。

表格单元格允许 2 个字符起的最短文本，因为表头常常是 `Feature`、`Retry` 这类短词。

批量返回的 `translations` 数量与输入不一致时，批次会二分重试，直到数量匹配或退化为单项，避免整批失败。

## 目标语言跳过

`shouldSkipTranslation` 会判断文本是否已经主要是目标语言。如果文本中目标语言和源语言混杂，策略是：

- 完全目标语言：跳过，避免重复生成。
- 混合文本：保留原文，让模型只处理需要转换的部分。
- 术语、品牌、代码标识符：尽量由术语表和提示词约束，不在本地硬替换。

## 内联标签与链接回填

页面提示词要求模型在译文中保留 `<strong>`、`<em>`、`<code>`、`<a>` 等简单内联标签。实测模型经常保留标签壳但丢掉 `href`，因此渲染阶段会在 sanitize 之后做一次链接回填：按出现位置把原文 `<a>` 的 `href` 复制到缺少 href 的译文链接上，并补 `rel="noreferrer noopener"`。只补不覆盖，且仍走允许协议白名单（`https:`、`http:`、`mailto:`、`#`、`/`）。

## 缓存键

缓存 key 必须覆盖会影响输出的维度：

- API URL
- 模型
- 源语言
- 目标语言
- 术语表
- 页面系统提示词
- 页面用户提示词
- 源文本

任何影响模型输出的配置变化，都应导致缓存 key 变化。

## 失败重试

模型调用失败时，`OpenAICompatibleChatClient` 对网络错误、429 和 5xx 做有限重试。重试应保持次数有限，并把最终错误回传给页面，避免页面一直显示 loading。

## 进度与 usage

进度包括：

- 总数、完成数、跳过数、失败数。
- 当前处理状态。
- 如果模型返回 usage，则累计 prompt/completion/total token。

页面默认显示 total token，悬浮后展示细分 usage。

