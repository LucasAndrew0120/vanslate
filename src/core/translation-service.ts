import { DEFAULT_TRANSLATION_SYSTEM_PROMPT, DEFAULT_TRANSLATION_USER_PROMPT } from "./defaults";
import type {
  ExtensionSettings,
  ProgressSink,
  SelectionTool,
  SettingsRepository,
  TranslateTextContext,
  TranslationCacheStore,
  Usage
} from "./types";
import type { ChatClient } from "./chat-client";
import {
  addUsage,
  buildToolMessages,
  cacheKey,
  extractJson,
  extractReasoning,
  joinUrl,
  normalizeInputItem,
  normalizeSelectionTools,
  parseGlossary,
  parseTranslations,
  readableError,
  renderTemplate,
  resolveToolModelSettings,
  resolveToolReasoning,
  resolveTranslationReasoning,
  shouldSkipTranslation,
  sourceLanguagePrompt,
  validateModelSettings,
  zeroUsage
} from "./utils";
import { buildChatRequestBody } from "./chat-client";

const VANSLATE_TRANSLATION_BATCH_CHARS = 5000;
const VANSLATE_TRANSLATION_BATCH_ITEMS = 60;
const VANSLATE_TRANSLATION_CONCURRENCY = 1;

export class TranslationService {
  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly cacheStore: TranslationCacheStore,
    private readonly chatClient: ChatClient,
    private readonly progressSink: ProgressSink,
    private readonly now: () => number = () => Date.now()
  ) {}

  async translateTexts(texts: unknown[], context: TranslateTextContext) {
    const settings = await this.settingsRepository.getSettings();
    this.validateSettings(settings);

    const normalizedItems = texts.map((item, index) => normalizeInputItem(item, index));
    const indexedTexts = normalizedItems.filter((item) => Boolean(item.text));

    if (!indexedTexts.length) {
      return { translations: [], cachedCount: 0 };
    }

    const translations = Array(normalizedItems.length).fill("");
    const misses: Array<ReturnType<typeof normalizeInputItem> & { cacheKey: string }> = [];
    const cacheKeysByIndex = new Map<number, string>();
    let cachedCount = 0;
    let completedCount = 0;
    let skippedCount = 0;
    let usageTotal = zeroUsage();

    for (const item of indexedTexts) {
      if (shouldSkipTranslation(item.text, settings)) {
        completedCount += 1;
        skippedCount += 1;
        this.progressSink.postItemResult(context, {
          id: item.id,
          index: item.index,
          skipped: true,
          reason: "already-target-language",
          usage: zeroUsage()
        });
        continue;
      }

      const key = cacheKey(item.text, settings, item.context);
      cacheKeysByIndex.set(item.index, key);
    }

    const cache = settings.enableCache ? await this.cacheStore.getMany(Array.from(cacheKeysByIndex.values())) : {};
    for (const item of indexedTexts) {
      if (!cacheKeysByIndex.has(item.index)) continue;
      const key = cacheKeysByIndex.get(item.index) || "";
      if (settings.enableCache && cache[key]?.translation) {
        translations[item.index] = cache[key].translation;
        cachedCount += 1;
        completedCount += 1;
        this.progressSink.postItemResult(context, {
          id: item.id,
          index: item.index,
          translation: cache[key].translation,
          cached: true,
          usage: zeroUsage()
        });
      } else {
        misses.push({ ...item, cacheKey: key });
      }
    }

    this.progressSink.postProgress(context, {
      done: completedCount,
      total: indexedTexts.length,
      cachedCount,
      skippedCount,
      stage: misses.length ? "translating" : "done"
    });

    const batches = chunkTranslationItems(misses);
    let nextBatchIndex = 0;
    const workerCount = Math.min(VANSLATE_TRANSLATION_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextBatchIndex < batches.length) {
        const batch = batches[nextBatchIndex];
        nextBatchIndex += 1;
        if (!batch) continue;
        try {
          const result = await this.translateBatch(batch, settings, context);
          const cacheUpdates: Record<string, { translation: string; updatedAt: number }> = {};
          batch.forEach((item, index) => {
            const translatedText = result.translations[index] || "";
            translations[item.index] = translatedText;
            if (settings.enableCache && translatedText) {
              cacheUpdates[item.cacheKey] = {
                translation: translatedText,
                updatedAt: this.now()
              };
            }
            this.progressSink.postItemResult(context, {
              id: item.id,
              index: item.index,
              translation: translatedText,
              cached: false,
              usage: index === 0 ? result.usage : zeroUsage()
            });
          });
          if (settings.enableCache) await this.cacheStore.setMany(cacheUpdates);
          usageTotal = addUsage(usageTotal, result.usage);
        } catch (error) {
          batch.forEach((item) => {
            this.progressSink.postItemResult(context, {
              id: item.id,
              index: item.index,
              error: readableError(error)
            });
          });
        }
        completedCount += batch.length;
        this.progressSink.postProgress(context, {
          done: completedCount,
          total: indexedTexts.length,
          cachedCount,
          skippedCount,
          usage: usageTotal,
          stage: completedCount >= indexedTexts.length ? "done" : "translating"
        });
      }
    }));
    return { translations, cachedCount, skippedCount, translatedCount: completedCount, usage: usageTotal };
  }

  async runSelectionTool(toolId: string, text: string) {
    const settings = await this.settingsRepository.getSettings();
    this.validateSettings(settings);
    const tools = normalizeSelectionTools(settings.selectionTools);
    const enabledTools = tools.filter((item) => item.enabled !== false);
    const tool = enabledTools.find((item) => item.id === toolId) || enabledTools[0];
    if (!tool) throw new Error("未配置可用工具。");
    const input = String(text || "").trim();
    if (!input) throw new Error("请先选择要处理的文本。");

    const result = await this.runToolRequest(settings, tool, input);
    return {
      toolId: tool.id,
      toolName: tool.name,
      text: result.content,
      reasoning: extractReasoning(result.message),
      usage: result.usage
    };
  }

  async debugSelectionTool(rawTool: unknown, text: string, settingsOverride: Partial<ExtensionSettings> | null) {
    const stored = await this.settingsRepository.getSettings();
    const settings = {
      ...stored,
      ...(settingsOverride || {})
    } as ExtensionSettings;
    this.validateSettings(settings);
    const tool = normalizeSelectionTools([rawTool])[0];
    if (!tool) throw new Error("调试工具配置不完整。");
    const input = String(text || "").trim();
    if (!input) throw new Error("请输入调试文本。");

    const promptVars = this.promptVars(settings, input);
    const effective = resolveToolModelSettings(settings, tool);
    validateModelSettings(effective);
    const messages = buildToolMessages(tool, promptVars);
    const endpoint = joinUrl(effective.baseUrl, "/chat/completions");
    const reasoning = resolveToolReasoning(settings, tool);
    const body = buildChatRequestBody({
      endpoint,
      apiKey: effective.apiKey,
      model: effective.model,
      temperature: 0.3,
      messages,
      retryCount: Number(settings.retryCount) || 0,
      reasoning
    });
    const response = await this.chatClient.complete({
      endpoint,
      apiKey: effective.apiKey,
      model: effective.model,
      temperature: 0.3,
      messages,
      retryCount: Number(settings.retryCount) || 0,
      reasoning
    });
    return {
      request: {
        endpoint,
        model: effective.model,
        messages,
        body
      },
      output: response.content,
      reasoning: extractReasoning(response.message),
      rawMessage: response.message,
      usage: response.usage
    };
  }

  async translateWord(text: string) {
    const settings = await this.settingsRepository.getSettings();
    this.validateSettings(settings);
    const word = String(text || "").trim();
    if (!word) throw new Error("No word selected.");

    const response = await this.chatClient.complete({
      endpoint: joinUrl(settings.baseUrl, "/chat/completions"),
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: 0.2,
      retryCount: Number(settings.retryCount) || 0,
      reasoning: resolveToolReasoning(settings, null),
      messages: [
        {
          role: "system",
          content: "You are a bilingual dictionary engine. You only output valid JSON."
        },
        {
          role: "user",
          content: [
            `Explain the single word or short term "${word}" for a ${settings.targetLanguage} reader.`,
            "Return only JSON in this exact shape:",
            "{\"word\":\"...\",\"phonetic\":\"...\",\"translation\":\"...\",\"partOfSpeech\":\"...\",\"definitions\":[\"...\"],\"examples\":[{\"source\":\"...\",\"translation\":\"...\"}]}",
            "Definitions should be concise but useful. Include phonetic if available."
          ].join("\n")
        }
      ]
    });

    const parsed = JSON.parse(extractJson(response.content));
    return {
      word: String(parsed.word || word),
      phonetic: String(parsed.phonetic || ""),
      translation: String(parsed.translation || ""),
      partOfSpeech: String(parsed.partOfSpeech || ""),
      definitions: Array.isArray(parsed.definitions) ? parsed.definitions.map(String) : [],
      examples: Array.isArray(parsed.examples) ? parsed.examples.map((item: Record<string, unknown>) => ({
        source: String(item?.source || ""),
        translation: String(item?.translation || "")
      })).filter((item: { source: string; translation: string }) => item.source || item.translation) : [],
      usage: response.usage
    };
  }

  private async translateBatch(
    items: Array<{ text: string; context?: string }>,
    settings: ExtensionSettings,
    page: { pageTitle?: string; pageUrl?: string } = {}
  ): Promise<{ translations: string[]; usage: Usage }> {
    const texts = items.map((item) => item.text);
    const contexts = items.map((item) => String(item.context || "").trim());
    const hasContext = contexts.some(Boolean);
    const glossary = parseGlossary(settings.glossary);
    const glossaryText = glossary.length
      ? `Use this glossary exactly when applicable:\n${glossary.map((item) => `${item.source} => ${item.target}`).join("\n")}`
      : "No glossary is provided.";
    const pageLines = [
      page.pageTitle ? `Page title: ${page.pageTitle}` : "",
      page.pageUrl ? `Page URL: ${page.pageUrl}` : ""
    ].filter(Boolean).join("\n");
    const contextRule = hasContext
      ? "contexts[i] is the nearest section heading for texts[i]. Use it only as background context for terminology, tone, and pronouns; never translate or output it."
      : "";
    const template = renderTemplate(settings.translationUserPrompt || DEFAULT_TRANSLATION_USER_PROMPT, {
      text: texts.join("\n\n"),
      textsJson: JSON.stringify(hasContext ? { texts, contexts } : { texts }),
      sourceLanguage: settings.sourceLanguage,
      sourceLanguagePrompt: sourceLanguagePrompt(settings.sourceLanguage),
      targetLanguage: settings.targetLanguage,
      glossary: settings.glossary,
      glossaryBlock: glossaryText,
      url: page.pageUrl || ""
    });
    const prompt = [pageLines, contextRule, template].filter(Boolean).join("\n");

    const response = await this.chatClient.complete({
      endpoint: joinUrl(settings.baseUrl, "/chat/completions"),
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: 0.2,
      retryCount: Number(settings.retryCount) || 0,
      reasoning: resolveTranslationReasoning(settings),
      messages: [
        {
          role: "system",
          content: settings.translationSystemPrompt || DEFAULT_TRANSLATION_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const translations = parseTranslations(response.content);
    if (translations.length !== texts.length) {
      // Models occasionally drop or merge an item. Splitting the batch keeps
      // the rest of the page translated instead of failing all items at once.
      if (items.length > 1) {
        const middle = Math.ceil(items.length / 2);
        const [left, right] = await Promise.all([
          this.translateBatch(items.slice(0, middle), settings, page),
          this.translateBatch(items.slice(middle), settings, page)
        ]);
        return {
          translations: [...left.translations, ...right.translations],
          usage: addUsage(left.usage, right.usage)
        };
      }
      throw new Error("The model returned an unexpected translation count.");
    }
    return {
      translations,
      usage: response.usage
    };
  }

  private async runToolRequest(settings: ExtensionSettings, tool: SelectionTool, input: string) {
    const effective = resolveToolModelSettings(settings, tool);
    validateModelSettings(effective);
    const messages = buildToolMessages(tool, this.promptVars(settings, input));
    return this.chatClient.complete({
      endpoint: joinUrl(effective.baseUrl, "/chat/completions"),
      apiKey: effective.apiKey,
      model: effective.model,
      temperature: 0.3,
      messages,
      retryCount: Number(settings.retryCount) || 0,
      reasoning: resolveToolReasoning(settings, tool)
    });
  }

  private promptVars(settings: ExtensionSettings, text: string): Record<string, unknown> {
    return {
      text,
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      glossary: settings.glossary,
      url: ""
    };
  }

  private validateSettings(settings: ExtensionSettings): void {
    validateModelSettings({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.activeModel || settings.model
    });
  }
}

/**
 * Groups items by character budget so a full page usually needs a handful of
 * requests instead of one per four blocks. A single oversized block still gets
 * its own batch.
 */
function chunkTranslationItems<T extends { text: string }>(items: T[]): T[][] {
  const output: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const length = item.text.length;
    const wouldOverflow = current.length > 0
      && (chars + length > VANSLATE_TRANSLATION_BATCH_CHARS || current.length >= VANSLATE_TRANSLATION_BATCH_ITEMS);
    if (wouldOverflow) {
      output.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += length;
  }
  if (current.length) output.push(current);
  return output;
}
