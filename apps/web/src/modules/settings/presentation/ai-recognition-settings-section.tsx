import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Brain, Sparkles, TestTube2 } from "lucide-react";
import { AIErrorDetailsDialog } from "@/components/ai-recognition/ai-error-details-dialog";
import { Button } from "@/components/ui/button";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/I18nProvider";
import { createAIErrorDetails, type AIErrorDetails } from "@/lib/ai-error-details";
import { cn } from "@/lib/utils";
import {
  canonicalAIRecognitionTransportProtocol,
  type AiModelListItem,
  type AiRecognitionProviderType,
  type AiRecognitionSettings,
} from "@/lib/api/schemas/ai-recognition";
import { resolveAIProviderEndpoint } from "@renewlet/shared/ai-provider-endpoints";
import {
  aiThinkingDefaultLabelKey,
  getAIThinkingOptions,
  normalizeAIThinkingControl,
  thinkingControlFromOptionId,
  thinkingOptionId,
} from "@/modules/ai-recognition/domain/model-capabilities";
import { getAIRecognitionSettingsBlocker } from "@/modules/ai-recognition/domain/settings-readiness";
import { aiRecognitionService } from "@/services/ai-recognition-service";
import { AIModelCombobox, AIModelModeSwitch } from "./ai-model-combobox";
import { LoadingButtonContent } from "./settings-shared-controls";
import type { SecretMutation } from "@renewlet/shared/schemas/secrets";
import { getSettingsSectionClassName } from "./settings-layout";

const AI_PROVIDER_TYPES = ["openai", "anthropic", "gemini", "openai-compatible"] as const satisfies readonly AiRecognitionProviderType[];
const MODEL_DEFAULT_THINKING_ID = "model-default";
const AI_PROVIDER_TYPE_LABEL_KEYS = {
  openai: "aiRecognition.providerType.openai",
  anthropic: "aiRecognition.providerType.anthropic",
  gemini: "aiRecognition.providerType.gemini",
  "openai-compatible": "aiRecognition.providerType.openaiCompatible",
} as const;

interface AIModelListState {
  status: "idle" | "loading" | "success" | "error";
  models: AiModelListItem[];
  error: string | null;
  truncated: boolean;
}

const EMPTY_MODEL_LIST_STATE: AIModelListState = {
  status: "idle",
  models: [],
  error: null,
  truncated: false,
};

function canListAIModels(settings: AiRecognitionSettings, apiKeyConfigured: boolean): boolean {
  const endpoint = resolveAIProviderEndpoint(settings);
  if (endpoint.baseUrlRequired && !settings.baseUrl.trim()) return false;
  if (endpoint.apiKeyRequired && !settings.apiKey.trim() && !apiKeyConfigured) return false;
  return true;
}

interface AIRecognitionSettingsSectionProps {
  id: string;
  className?: string;
  settings: AiRecognitionSettings;
  onChange: (settings: AiRecognitionSettings) => void;
  disabled?: boolean;
  apiKeyConfigured?: boolean;
  onClearApiKey?: () => void;
}

export function AIRecognitionSettingsSection({
  id,
  className,
  settings,
  onChange,
  disabled = false,
  apiKeyConfigured = false,
  onClearApiKey = () => undefined,
}: AIRecognitionSettingsSectionProps) {
  const { t } = useI18n();
  const [testing, setTesting] = useState(false);
  const [modelListState, setModelListState] = useState<AIModelListState>(EMPTY_MODEL_LIST_STATE);
  const [aiErrorDetails, setAIErrorDetails] = useState<AIErrorDetails | null>(null);
  const [aiErrorDetailsOpen, setAIErrorDetailsOpen] = useState(false);
  const modelListRequestRef = useRef(0);
  const canonicalSettings = useMemo(() => {
    const transportProtocol = canonicalAIRecognitionTransportProtocol(settings.providerType);
    return {
      ...settings,
      transportProtocol,
      defaultThinkingControl: normalizeAIThinkingControl(settings.providerType, transportProtocol, settings.model, settings.defaultThinkingControl),
    };
  }, [settings]);
  const thinkingOptions = useMemo(
    () => getAIThinkingOptions(canonicalSettings.providerType, canonicalSettings.transportProtocol, canonicalSettings.model),
    [canonicalSettings.model, canonicalSettings.providerType, canonicalSettings.transportProtocol],
  );
  const endpoint = useMemo(
    () => resolveAIProviderEndpoint({
      apiKey: canonicalSettings.apiKey,
      baseUrl: canonicalSettings.baseUrl,
      providerType: canonicalSettings.providerType,
    }),
    [canonicalSettings.apiKey, canonicalSettings.baseUrl, canonicalSettings.providerType],
  );
  const selectedThinkingId = canonicalSettings.defaultThinkingControl
    ? thinkingOptionId(canonicalSettings.defaultThinkingControl)
    : MODEL_DEFAULT_THINKING_ID;
  const testBlocker = getAIRecognitionSettingsBlocker(canonicalSettings, apiKeyConfigured);
  const apiKeyMutation = (): SecretMutation => canonicalSettings.apiKey.trim()
    ? { action: "set", value: canonicalSettings.apiKey.trim() }
    : { action: "keep" };

  useEffect(() => {
    // 模型列表来自第三方 provider，必须随凭证/地址变化失效；旧请求返回较慢时也不能覆盖新配置。
    modelListRequestRef.current += 1;
    setModelListState(EMPTY_MODEL_LIST_STATE);
    setAIErrorDetails(null);
    setAIErrorDetailsOpen(false);
  }, [canonicalSettings.apiKey, canonicalSettings.baseUrl, canonicalSettings.providerType, canonicalSettings.transportProtocol]);

  const update = (patch: Partial<AiRecognitionSettings>) => {
    if (disabled) return;
    const providerType = patch.providerType ?? settings.providerType;
    const transportProtocol = canonicalAIRecognitionTransportProtocol(providerType);
    const next = { ...settings, ...patch, providerType, transportProtocol };
    next.defaultThinkingControl = normalizeAIThinkingControl(next.providerType, next.transportProtocol, next.model, next.defaultThinkingControl);
    onChange(next);
  };

  const handleProviderTypeChange = (providerType: AiRecognitionProviderType) => {
    update({
      providerType,
      defaultThinkingControl: null,
    });
  };

  const handleThinkingChange = (id: string) => {
    update({
      defaultThinkingControl: id === MODEL_DEFAULT_THINKING_ID
        ? null
        : thinkingControlFromOptionId(thinkingOptions, id),
    });
  };

  const handleRefreshModels = async () => {
    if (disabled) return;
    const baseUrl = canonicalSettings.baseUrl.trim();
    const apiKey = canonicalSettings.apiKey.trim();
    if (endpoint.baseUrlRequired && !baseUrl) {
      setModelListState({ ...EMPTY_MODEL_LIST_STATE, status: "error", error: t("aiRecognition.baseUrlRequired") });
      return;
    }
    if (endpoint.apiKeyRequired && !apiKey && !apiKeyConfigured) {
      setModelListState({ ...EMPTY_MODEL_LIST_STATE, status: "error", error: t("aiRecognition.apiKeyRequired") });
      return;
    }

    const requestId = modelListRequestRef.current + 1;
    modelListRequestRef.current = requestId;
    setModelListState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const response = await aiRecognitionService.listModels({
        providerType: canonicalSettings.providerType,
        baseUrl,
        apiKey: apiKeyMutation(),
      });
      if (modelListRequestRef.current !== requestId) return;
      setModelListState({
        status: "success",
        models: response.models,
        error: null,
        truncated: response.truncated,
      });
    } catch (error) {
      if (modelListRequestRef.current !== requestId) return;
      const details = createAIErrorDetails(error, t("aiRecognition.modelListFailedDescription"));
      setAIErrorDetails(details);
      setAIErrorDetailsOpen(true);
      setModelListState({
        ...EMPTY_MODEL_LIST_STATE,
        status: "error",
        error: null,
      });
    }
  };

  const handleModelInputModeChange = (modelInputMode: AiRecognitionSettings["modelInputMode"]) => {
    if (disabled) return;
    update({ modelInputMode });
    if (
      modelInputMode === "select"
      && canListAIModels(canonicalSettings, apiKeyConfigured)
      && modelListState.status !== "loading"
      && (modelListState.status === "idle" || modelListState.status === "error" || modelListState.models.length === 0)
    ) {
      void handleRefreshModels();
    }
  };

  const handleTestConnection = async () => {
    if (disabled) return;
    if (testBlocker) {
      toast.error(t("aiRecognition.testBlockedTitle"), { description: t(testBlocker) });
      return;
    }
    setTesting(true);
    try {
      await aiRecognitionService.testConnection(canonicalSettings, apiKeyMutation());
      setAIErrorDetails(null);
      toast.success(t("aiRecognition.testSucceeded"));
    } catch (error) {
      const details = createAIErrorDetails(error, t("aiRecognition.testFailedDescription"));
      setAIErrorDetails(details);
      setAIErrorDetailsOpen(true);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section id={id} className={getSettingsSectionClassName(className)}>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">{t("aiRecognition.settingsTitle")}</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("aiRecognition.settingsDescription")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="relative shrink-0 gap-2 border-border"
          onClick={() => void handleTestConnection()}
          disabled={disabled || testing}
          aria-busy={testing ? true : undefined}
        >
          <LoadingButtonContent loading={testing} loadingLabel={t("aiRecognition.testing")}>
            <TestTube2 className="h-4 w-4" />
            {t("aiRecognition.testConnection")}
          </LoadingButtonContent>
        </Button>
      </div>

      {aiErrorDetails ? (
        <div className="mb-5 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border"
            onClick={() => setAIErrorDetailsOpen(true)}
          >
            <AlertTriangle className="h-4 w-4" />
            {t("aiRecognition.errorDetailsOpenLast")}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-5">
        <FormFieldRow
          alignAt="md"
          rowClassName="md:grid-cols-2 md:gap-x-5"
          data-testid="ai-provider-model-grid"
        >
          <FormField id="ai-provider-type" label={t("aiRecognition.providerType")}>
            {({ id: fieldId }) => (
              <Select value={canonicalSettings.providerType} disabled={disabled} onValueChange={(value) => handleProviderTypeChange(value as AiRecognitionProviderType)}>
                <SelectTrigger id={fieldId} className="border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_PROVIDER_TYPES.map((providerType) => (
                    <SelectItem key={providerType} value={providerType}>{t(AI_PROVIDER_TYPE_LABEL_KEYS[providerType])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField
            id="ai-model"
            labelSlot={(
              <div className="flex min-h-7 min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-1" data-testid="ai-model-label-row">
                <Label htmlFor="ai-model">{t("aiRecognition.model")}</Label>
                <AIModelModeSwitch
                  mode={canonicalSettings.modelInputMode}
                  disabled={disabled}
                  onModeChange={handleModelInputModeChange}
                />
              </div>
            )}
          >
            {({ id: fieldId }) => (
              <AIModelCombobox
                id={fieldId}
                value={canonicalSettings.model}
                onValueChange={(model) => update({ model })}
                mode={canonicalSettings.modelInputMode}
                models={modelListState.models}
                status={modelListState.status}
                error={modelListState.error}
                truncated={modelListState.truncated}
                canAutoRefreshModels={canListAIModels(canonicalSettings, apiKeyConfigured)}
                onRequestModels={() => void handleRefreshModels()}
                disabled={disabled}
                placeholder={t("aiRecognition.modelPlaceholder")}
              />
            )}
          </FormField>
        </FormFieldRow>

        <FormFieldRow alignAt="md" rowClassName="md:grid-cols-2 md:gap-x-5">
          <FormField
            id="ai-base-url"
            label={t("aiRecognition.baseUrl")}
            description={t("aiRecognition.baseUrlHelp")}
          >
            {({ id: fieldId, describedBy }) => (
              <Input
                id={fieldId}
                value={canonicalSettings.baseUrl}
                disabled={disabled}
                onChange={(event) => update({ baseUrl: event.target.value })}
                placeholder={endpoint.baseUrlRequired ? "https://api.example.com/v1" : t("aiRecognition.baseUrlPlaceholder")}
                className="border-border bg-secondary"
                inputMode="url"
                aria-describedby={describedBy}
              />
            )}
          </FormField>

          <FormField
            id="ai-api-key"
            labelSlot={(
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ai-api-key">{t("aiRecognition.apiKey")}</Label>
                {apiKeyConfigured ? (
                  <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onClearApiKey}>
                    {t("settings.turnstileClearSecret")}
                  </Button>
                ) : null}
              </div>
            )}
            description={t("aiRecognition.apiKeyHelp")}
          >
            {({ id: fieldId, describedBy }) => (
              <Input
                id={fieldId}
                type="password"
                autoComplete="off"
                value={canonicalSettings.apiKey}
                disabled={disabled}
                onChange={(event) => update({ apiKey: event.target.value })}
                placeholder={apiKeyConfigured ? t("settings.turnstileSecretConfiguredPlaceholder") : endpoint.apiKeyRequired ? "sk-..." : t("aiRecognition.apiKeyOptionalPlaceholder")}
                className="border-border bg-secondary"
                aria-describedby={describedBy}
              />
            )}
          </FormField>
        </FormFieldRow>
      </div>

      <div className="mt-5 grid gap-2">
        <Label htmlFor="ai-thinking" className="inline-flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          {t("aiRecognition.defaultThinking")}
        </Label>
        <Select value={selectedThinkingId} disabled={disabled} onValueChange={handleThinkingChange}>
          <SelectTrigger id="ai-thinking" className="border-border bg-secondary md:max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={MODEL_DEFAULT_THINKING_ID}>{t(aiThinkingDefaultLabelKey(canonicalSettings.model))}</SelectItem>
            {thinkingOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs leading-5 text-muted-foreground">
          {thinkingOptions.length > 0
            ? t("aiRecognition.thinkingHelp")
            : t(canonicalSettings.providerType === "openai-compatible" ? "aiRecognition.thinkingUnsupportedCompatible" : "aiRecognition.thinkingUnsupportedModel")}
        </p>
      </div>
      <AIErrorDetailsDialog
        open={aiErrorDetailsOpen}
        details={aiErrorDetails}
        onOpenChange={setAIErrorDetailsOpen}
      />
    </section>
  );
}
