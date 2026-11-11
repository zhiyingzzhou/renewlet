/**
 * 表单字段组合原语。
 *
 * 架构位置：统一字段 label、说明、错误和 aria 关系；业务表单只负责提供校验结果和控件本体。
 */
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { FieldError } from "@/components/ui/field-error";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function formFieldDescribedBy(...ids: Array<string | false | null | undefined>) {
  const value = ids.filter((id): id is string => typeof id === "string" && id.length > 0).join(" ");
  return value || undefined;
}

export interface FormFieldRenderProps {
  id: string;
  errorId: string;
  descriptionId: string | undefined;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FormFieldProps {
  id: string;
  label?: ReactNode | undefined;
  labelId?: string | undefined;
  labelSlot?: ReactNode | undefined;
  error?: ReactNode | undefined;
  errorId?: string | undefined;
  description?: ReactNode | undefined;
  descriptionId?: string | undefined;
  describedBy?: string | undefined;
  className?: string | undefined;
  labelClassName?: string | undefined;
  descriptionClassName?: string | undefined;
  errorClassName?: string | undefined;
  renderError?: boolean | undefined;
  children: (field: FormFieldRenderProps) => ReactNode;
}

export type FormFieldRowBreakpoint = "sm" | "md" | "lg";
type FormFieldRowTracks = 2 | 3;

interface FormFieldRowContextValue {
  alignAt: FormFieldRowBreakpoint;
  tracks: FormFieldRowTracks;
}

const FormFieldRowContext = createContext<FormFieldRowContextValue | null>(null);

const fieldLayoutClasses: Record<FormFieldRowBreakpoint, Record<FormFieldRowTracks, string>> = {
  sm: {
    2: "sm:row-span-2 sm:grid-rows-subgrid",
    3: "sm:row-span-3 sm:grid-rows-subgrid",
  },
  md: {
    2: "md:row-span-2 md:grid-rows-subgrid",
    3: "md:row-span-3 md:grid-rows-subgrid",
  },
  lg: {
    2: "lg:row-span-2 lg:grid-rows-subgrid",
    3: "lg:row-span-3 lg:grid-rows-subgrid",
  },
};

const labelLayoutClasses: Record<FormFieldRowBreakpoint, string> = {
  sm: "sm:self-end",
  md: "md:self-end",
  lg: "lg:self-end",
};

const actionLabelPlaceholderClasses: Record<FormFieldRowBreakpoint, string> = {
  sm: "hidden sm:block",
  md: "hidden md:block",
  lg: "hidden lg:block",
};

const rowLayoutClasses: Record<FormFieldRowBreakpoint, string> = {
  sm: "sm:gap-y-2",
  md: "md:gap-y-2",
  lg: "lg:gap-y-2",
};

export function FormField({
  id,
  label,
  labelId,
  labelSlot,
  error,
  errorId,
  description,
  descriptionId,
  describedBy,
  className,
  labelClassName,
  descriptionClassName,
  errorClassName,
  renderError = true,
  children,
}: FormFieldProps) {
  const row = useContext(FormFieldRowContext);
  const resolvedErrorId = errorId ?? `${id}-error`;
  const resolvedDescriptionId = description ? (descriptionId ?? `${id}-description`) : undefined;
  const field = {
    id,
    errorId: resolvedErrorId,
    descriptionId: resolvedDescriptionId,
    describedBy: formFieldDescribedBy(describedBy, resolvedDescriptionId, error ? resolvedErrorId : undefined),
    invalid: Boolean(error),
  } satisfies FormFieldRenderProps;
  const shouldRenderError = renderError && row === null;

  return (
    <div
      data-slot="form-field"
      className={cn(
        "grid min-w-0 gap-2",
        row && fieldLayoutClasses[row.alignAt][row.tracks],
        className,
      )}
    >
      {row || labelSlot != null || label != null ? (
        <div
          data-slot="form-field-label"
          className={cn("grid min-w-0", row && labelLayoutClasses[row.alignAt])}
        >
          {labelSlot ?? (label != null ? (
            <Label id={labelId} htmlFor={id} className={labelClassName}>
              {label}
            </Label>
          ) : null)}
        </div>
      ) : null}
      <div data-slot="form-field-control" className="grid min-w-0 gap-2 self-start">
        {children(field)}
      </div>
      {description ? (
        <p
          id={resolvedDescriptionId}
          data-slot="form-field-description"
          className={cn("self-start text-xs text-muted-foreground", descriptionClassName)}
        >
          {description}
        </p>
      ) : null}
      {shouldRenderError ? <FieldError id={resolvedErrorId} message={error} className={errorClassName} /> : null}
    </div>
  );
}

export interface FormFieldRowError {
  id: string;
  message?: ReactNode | undefined;
  className?: string | undefined;
}

export interface FormFieldRowProps extends HTMLAttributes<HTMLDivElement> {
  alignAt: FormFieldRowBreakpoint;
  rowClassName?: string | undefined;
  errors?: FormFieldRowError[] | undefined;
}

function hasFieldDescription(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement<FormFieldProps & { children?: ReactNode }>(child)) return false;
    if (child.type === FormField) return Boolean(child.props.description);
    return child.type === Fragment && hasFieldDescription(child.props.children);
  });
}

export function FormFieldRow({
  alignAt,
  children,
  className,
  rowClassName,
  errors = [],
  ...props
}: FormFieldRowProps) {
  const visibleErrors = errors.filter((item) => Boolean(item.message));
  const tracks: FormFieldRowTracks = hasFieldDescription(children) ? 3 : 2;

  return (
    <div
      data-slot="form-field-row"
      data-align-at={alignAt}
      data-tracks={tracks}
      className={cn("grid min-w-0 grid-cols-1", visibleErrors.length > 0 && "gap-2", className)}
      {...props}
    >
      <FormFieldRowContext.Provider value={{ alignAt, tracks }}>
        {/* 说明与错误只能扩展各自轨道，不能反向改变同一行 label、控件或 action 的共享基线。 */}
        <div className={cn("grid min-w-0 grid-cols-1 gap-x-4 gap-y-4", rowLayoutClasses[alignAt], rowClassName)}>
          {children}
        </div>
      </FormFieldRowContext.Provider>
      {visibleErrors.length > 0 ? (
        <div data-slot="form-field-row-errors" className="grid gap-1">
          {visibleErrors.map((item) => (
            <FieldError key={item.id} id={item.id} message={item.message} className={item.className} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface FormFieldRowActionProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  controlClassName?: string | undefined;
}

export function FormFieldRowAction({
  children,
  className,
  controlClassName,
  ...props
}: FormFieldRowActionProps) {
  const row = useContext(FormFieldRowContext);

  if (!row) {
    throw new Error("FormFieldRowAction must be rendered inside FormFieldRow");
  }

  return (
    <div
      data-slot="form-field-row-action"
      className={cn("grid min-w-0 gap-2", fieldLayoutClasses[row.alignAt][row.tracks], className)}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="form-field-row-action-label-placeholder"
        className={actionLabelPlaceholderClasses[row.alignAt]}
      />
      <div
        data-slot="form-field-row-action-control"
        className={cn("flex min-w-0 items-start self-start", controlClassName)}
      >
        {children}
      </div>
    </div>
  );
}
