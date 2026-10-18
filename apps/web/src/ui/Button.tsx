import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  type?: "button" | "submit";
}

/** The one button. At most one `primary` per view; `type` defaults to "button" so it never submits by accident. */
export function Button({ variant = "secondary", size = "md", type = "button", className, ...rest }: ButtonProps) {
  const classes = ["ui-btn", `ui-btn-${variant}`, `ui-btn-${size}`, className].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...rest} />;
}
