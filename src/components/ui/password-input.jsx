import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * ── DO NOT ADD A DEFAULT `autoComplete` HERE ───────────────────────────────
 *
 * This component serves two populations with opposite needs. On /login,
 * /register and /reset-password the user is typing THEIR OWN password and a
 * password manager filling it is the point. On the admin credential screens
 * (SMTP, the Evolution API key, another user's password) and on vault fields
 * like a card CVV, the browser has no business writing anything: it fills a
 * SAVED password over a secret that is not a password at all, and the form
 * happily encrypts and stores whatever ends up in the box.
 *
 * That is not hypothetical — it is how six characters of autofill got stored as
 * the Evolution API key and turned every send into an "engine rejected the key".
 *
 * So the opt-out is per-callsite: pass `autoComplete="new-password"` on fields
 * the browser must keep out of. `"off"` is not enough — Chrome has ignored it on
 * password inputs for years; `new-password` is the value it actually honours.
 * `{...props}` is spread last, so any caller's value wins.
 */
const PasswordInput = React.forwardRef(({ className, ...props }, ref) => {
  const [showPassword, setShowPassword] = React.useState(false)

  return (
    <div className="relative">
      <Input
        type={showPassword ? "text" : "password"}
        className={cn("pr-10", className)}
        ref={ref}
        {...props}
      />
      <button
        type="button"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
        onClick={() => setShowPassword((prev) => !prev)}
      >
        {showPassword ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
        <span className="sr-only">{showPassword ? "Hide password" : "Show password"}</span>
      </button>
    </div>
  )
})
PasswordInput.displayName = "PasswordInput"

export { PasswordInput }
