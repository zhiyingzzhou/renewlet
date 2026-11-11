/**
 * 订阅 Logo 选择器（用于新增/编辑订阅的 logo）。
 *
 * 支持：
 * - 通过统一 Logo Resolver 搜索内置品牌图标与网站/Favicon 备用候选
 * - 上传本地图片并裁剪（ImageCropDialog）
 *
 * 注意：
 * - Favicon 备用候选依赖浏览器加载外部资源，网络不通时可能加载失败（UI 有降级处理）
 *
 * 状态链路：
 * ```
 * serviceName -> useMediaCandidates -> 选择 URL
 * 文件上传 -> 裁剪 -> useCroppedImageUpload -> /api/app/assets/{id}
 * ```
 *
 * 注意： 外层表单必须关注 uploadStatus，上传中不允许保存订阅，避免临时预览值被持久化。
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DeferredImageCropDialog, preloadImageCropDialog } from '@/components/image-crop-dialog-loader';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Upload, Search, X, Loader2, Image as ImageIcon, Images, RefreshCw, Link } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FaviconResultImage } from '@/components/favicon-result-image';
import { MediaCandidateSearchPanel } from '@/components/media-candidate-search-panel';
import { MediaCandidateViewport } from '@/components/media-candidate-viewport';
import { MediaThumbnailButton } from '@/components/media-thumbnail-button';
import { LogoUrlInputPanel } from '@/components/logo-url-input-panel';
import { IMAGE_UPLOAD_ACCEPT } from '@/lib/upload-constraints';
import { useCroppedImageUpload, type UploadStatus } from '@/hooks/use-cropped-image-upload';
import { useMediaCandidates } from '@/hooks/use-media-candidates';
import { useUploadedLogoAssets } from '@/hooks/use-uploaded-logo-assets';
import { useI18n } from '@/i18n/I18nProvider';

/** 透出上传状态类型，方便表单弹窗阻止上传中的保存。 */
export type { UploadStatus };

const SEARCH_POPOVER_CLOSE_RESET_DELAY_MS = 200;

interface LogoPickerProps {
  /** 当前 logo（私有资产路径或 http(s) 外链）。 */
  value?: string | undefined;
  /** logo 变更回调（传 undefined 表示清空）。 */
  onChange: (logo: string | undefined) => void;
  /**
   * 上传状态变更回调（可选）。
   *
   * 用途：
   * - 外层表单/弹窗在上传未完成时禁用“保存/确认”，彻底杜绝把临时预览值写入数据库。
   */
  onUploadStatusChange?: ((status: UploadStatus) => void) | undefined;
  /** 服务名提示：打开弹窗时可自动填入并触发搜索。 */
  serviceName?: string | undefined;
  /** 订阅网站 URL；Logo 搜索会优先用它生成网站 favicon 备用候选。 */
  website?: string | undefined;
}

/** LogoPicker 组件。 */
export function LogoPicker({
  value,
  onChange,
  onUploadStatusChange,
  serviceName = '',
  website,
}: LogoPickerProps) {
  const { t } = useI18n();
  const uploadedLogos = useUploadedLogoAssets();
  const [uploadedLogosOpen, setUploadedLogosOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const search = useMediaCandidates({
    kind: "logo",
    autoQuery: serviceName,
    website,
    limit: 32,
    closeResetDelayMs: SEARCH_POPOVER_CLOSE_RESET_DELAY_MS,
  });

  const {
    fileInputRef,
    cropDialogOpen,
    setCropDialogOpen,
    uploadedImage,
    uploadStatus,
    uploadError,
    previewUrl,
    handleFileUpload,
    handleCropComplete,
    applyValue,
  } = useCroppedImageUpload({
    kind: "logo",
    filename: "logo.png",
    onChange,
    onUploadStatusChange,
  });

  const displayedLogo = previewUrl ?? value;

  const handleSearchOpenChange = (nextOpen: boolean) => {
    search.onOpenChange(nextOpen);
  };

  const handleUploadedLogosOpenChange = (nextOpen: boolean) => {
    setUploadedLogosOpen(nextOpen);
    if (nextOpen) {
      void uploadedLogos.loadInitial();
    }
  };

  const handleLinkOpenChange = (nextOpen: boolean) => {
    setLinkOpen(nextOpen);
  };

  const retryUploadedLogos = () => {
    void uploadedLogos.loadInitial();
  };

  const loadMoreUploadedLogos = () => {
    void uploadedLogos.loadMore();
  };

  return (
    <>
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <Label>{t("media.logo")}</Label>
      <div className="flex flex-wrap items-center gap-3" data-testid="logo-picker-control-row">
        <div className="group relative h-16 w-16 shrink-0 overflow-visible">
          <button
            type="button"
            aria-label={displayedLogo ? t("media.changeLogo") : t("media.uploadLogoImage")}
            className={cn(
              "relative flex h-16 w-16 items-center justify-center rounded-xl border-2 border-border transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              displayedLogo ? "media-thumbnail-canvas overflow-hidden hover:border-primary" : "border-dashed bg-secondary/50 hover:bg-secondary/80",
            )}
            onClick={() => fileInputRef.current?.click()}
            onFocus={preloadImageCropDialog}
            onPointerEnter={preloadImageCropDialog}
            onTouchStart={preloadImageCropDialog}
          >
            {displayedLogo ? (
              <div className="relative z-10 h-full w-full p-1">
                <FaviconResultImage
                  src={displayedLogo}
                  alt={t("media.logo")}
                  className="media-thumbnail-image"
                  onError={() => applyValue(undefined)}
                />
              </div>
            ) : (
              <ImageIcon className="w-6 h-6 text-muted-foreground" />
            )}
            {uploadStatus === "uploading" && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              </div>
            )}
          </button>
          {displayedLogo ? (
            <button
              type="button"
              aria-label={t("media.clearLogo")}
              onClick={() => applyValue(undefined)}
              className="absolute -right-1 -top-1 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-100 shadow-sm transition-opacity hover:bg-destructive/90 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:opacity-0 sm:group-hover:opacity-100"
            >
              <X className="w-3 h-3" />
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>

        <div className="grid min-w-0 w-fit max-w-full grid-cols-1 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full gap-2 text-primary border-primary/30 hover:border-primary hover:bg-primary/10"
            onClick={() => fileInputRef.current?.click()}
            onFocus={preloadImageCropDialog}
            onPointerEnter={preloadImageCropDialog}
            onTouchStart={preloadImageCropDialog}
          >
            {uploadStatus === "uploading" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            {t("media.uploadLogo")}
          </Button>

          <div className="flex w-max max-w-full flex-wrap items-center justify-start gap-2" data-testid="logo-picker-secondary-actions">
            <Popover open={uploadedLogosOpen} onOpenChange={handleUploadedLogosOpenChange}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-fit max-w-full shrink-0 gap-1.5 border-border px-3 text-xs"
                >
                  <Images className="w-3.5 h-3.5" />
                  <span className="min-w-0 truncate">{t("media.uploaded")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                aria-label={t("media.uploadedLogo")}
                className="media-candidate-popover media-candidate-popover-logo h5-logo-sheet h5-uploaded-logo-sheet w-80 border-border bg-card p-3"
                align="start"
                sideOffset={8}
                mobileDetent="large"
                data-testid="uploaded-logo-sheet"
              >
                <div className="media-candidate-popover-panel h5-uploaded-logo-panel gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{t("media.uploadedLogo")}</span>
                    <button
                      type="button"
                      onClick={() => handleUploadedLogosOpenChange(false)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <MediaCandidateViewport
                    className="h5-logo-sheet-results h5-uploaded-logo-results"
                    dataTestId="uploaded-logo-results"
                  >
                    {uploadedLogos.isLoading && uploadedLogos.assets.length === 0 && (
                      <div className="media-candidate-message flex items-center justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                        <span className="ml-2 text-sm text-muted-foreground">{t("media.loadingUploadedLogo")}</span>
                      </div>
                    )}

                    {uploadedLogos.error && uploadedLogos.assets.length === 0 && (
                      <div className="media-candidate-message grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                        <p className="text-sm text-destructive">{t("media.uploadedLogoLoadFailed")}</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-2 border-border"
                          onClick={retryUploadedLogos}
                          disabled={uploadedLogos.isLoading}
                        >
                          {uploadedLogos.isLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                          {t("media.retryUploadedLogo")}
                        </Button>
                      </div>
                    )}

                    {!uploadedLogos.isLoading && !uploadedLogos.error && uploadedLogos.hasLoaded && uploadedLogos.assets.length === 0 && (
                      <div className="media-candidate-message text-center py-3">
                        <ImageIcon className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" />
                        <p className="text-sm text-muted-foreground">{t("media.noUploadedLogo")}</p>
                      </div>
                    )}

                    {uploadedLogos.assets.length > 0 && (
                      <>
                        <div className="grid grid-cols-4 gap-2 p-1">
                          {uploadedLogos.assets.map((asset, index) => {
                            const label = asset.originalName ?? t("media.uploadedLogoOption", { index: index + 1 });
                            return (
                              <MediaThumbnailButton
                                key={asset.id}
                                src={asset.url}
                                alt={label}
                                tooltip={label}
                                selected={value === asset.url}
                                onClick={() => {
                                  applyValue(asset.url);
                                  handleUploadedLogosOpenChange(false);
                                }}
                              />
                            );
                          })}
                        </div>

                        {uploadedLogos.error && (
                          <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                            <p className="text-xs text-destructive">{t("media.uploadedLogoLoadFailed")}</p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 gap-2 border-border"
                              onClick={retryUploadedLogos}
                              disabled={uploadedLogos.isLoading}
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              {t("media.retryUploadedLogo")}
                            </Button>
                          </div>
                        )}

                        {uploadedLogos.hasMore && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-full gap-2 border-border"
                            onClick={loadMoreUploadedLogos}
                            disabled={uploadedLogos.isLoadingMore}
                          >
                            {uploadedLogos.isLoadingMore && <Loader2 className="w-4 h-4 animate-spin" />}
                            {t("media.loadMoreUploadedLogo")}
                          </Button>
                        )}
                      </>
                    )}
                  </MediaCandidateViewport>
                </div>
              </PopoverContent>
            </Popover>

            <Popover open={search.open} onOpenChange={handleSearchOpenChange}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-fit max-w-full shrink-0 gap-1.5 border-border px-3 text-xs"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span className="min-w-0 truncate">{t("media.search")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                aria-label={t("media.searchLogo")}
                className="media-candidate-popover media-candidate-popover-logo h5-logo-sheet h5-logo-search-sheet w-80 border-border bg-card p-4"
                align="start"
                sideOffset={8}
                mobileDetent="large"
                data-testid="logo-search-sheet"
              >
                <MediaCandidateSearchPanel
                  search={search}
                  title={t("media.searchLogo")}
                  placeholder={t("media.searchLogoPlaceholder")}
                  prompt={t("media.searchLogoPrompt")}
                  notFoundLabel={t("media.logoNotFound")}
                  notFoundHint={t("media.logoNotFoundHint")}
                  selectedValue={value}
                  onClose={() => handleSearchOpenChange(false)}
                  onSelect={(candidate) => {
                    applyValue(candidate.url);
                    handleSearchOpenChange(false);
                  }}
                  panelClassName="h5-logo-search-panel gap-4"
                  inputRowClassName="h5-logo-search-input-row"
                  searchButtonClassName="bg-primary text-primary-foreground"
                  resultsClassName="h5-logo-sheet-results h5-logo-search-results"
                  dataTestId="logo-search-results"
                  showEmptyIcon
                />
              </PopoverContent>
            </Popover>

            <Popover open={linkOpen} onOpenChange={handleLinkOpenChange}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-fit max-w-full shrink-0 gap-1.5 border-border px-3 text-xs"
                >
                  <Link className="w-3.5 h-3.5" />
                  <span className="min-w-0 truncate">{t("media.link")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                aria-label={t("media.logoLink")}
                className="media-candidate-popover media-candidate-popover-logo h5-logo-sheet h5-logo-link-sheet w-80 border-border bg-card p-4"
                align="start"
                sideOffset={8}
                mobileDetent="large"
                data-testid="logo-link-sheet"
              >
                <div className="media-candidate-popover-panel h5-logo-link-panel gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{t("media.logoLink")}</span>
                    <button
                      type="button"
                      onClick={() => handleLinkOpenChange(false)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <LogoUrlInputPanel
                    value={value}
                    onApply={(url) => {
                      applyValue(url);
                      handleLinkOpenChange(false);
                    }}
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {uploadStatus === "error" && (
            <p className="max-w-64 text-xs text-destructive">
              {uploadError ?? t("media.logoUploadFailed")}
            </p>
          )}
        </div>
      </div>
    </div>

    <DeferredImageCropDialog
      open={cropDialogOpen}
      onOpenChange={setCropDialogOpen}
      imageSrc={uploadedImage}
      onCropComplete={handleCropComplete}
      aspectRatio={1}
      // Logo 在 UI 中展示尺寸很小，限制最大导出尺寸可避免生成超大图片导致上传失败
      maxOutputSize={256}
    />
    </>
  );
}
