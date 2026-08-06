import { useSignedUrl, initials } from "@/lib/media";
import { cn } from "@/lib/utils";

type Props = {
  src?: string | null;
  name?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  square?: boolean;
  online?: boolean;
  className?: string;
};

const sizes = {
  xs: "h-7 w-7 text-[10px]",
  sm: "h-9 w-9 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-14 w-14 text-base",
  xl: "h-24 w-24 text-2xl",
};

export function JubiAvatar({ src, name, size = "md", square, online, className }: Props) {
  const url = useSignedUrl(src);
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <span
        className={cn(
          "flex items-center justify-center overflow-hidden bg-accent font-semibold text-accent-foreground",
          square ? "rounded-2xl" : "rounded-full",
          sizes[size],
        )}
      >
        {url ? (
          <img src={url} alt={name ?? "avatar"} className="h-full w-full object-cover" />
        ) : (
          initials(name)
        )}
      </span>
      {online !== undefined && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background",
            online ? "bg-online" : "bg-muted-foreground",
          )}
        />
      )}
    </span>
  );
}