import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { api, setAuthToken, getAuthToken } from "@/lib/auth";
import { AnimatedBlobBackground } from "@/components/motion/AnimatedBlobBackground";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — OrbitAvanya CRM" },
      { name: "description", content: "Sign in to OrbitAvanya CRM" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("verified") === "1") {
      toast.success("Email verified. You can now sign in.");
      window.history.replaceState({}, "", "/auth");
    }
    if (getAuthToken()) navigate({ to: "/dashboard" });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const data = await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ email, password, full_name: name }),
        });
        toast.success(data.message || "Account created. Check your email.");
        setMode("signin");
      } else {
        const data = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        setAuthToken(data.token);
        toast.success("Signed in successfully.");
        navigate({ to: "/dashboard" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot() {
    if (!email) return toast.error("Enter your email first.");
    setLoading(true);
    try {
      const data = await api("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      toast.success(data.message || "If the email exists, a reset link was sent.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send reset email.");
    } finally {
      setLoading(false);
    }
  }

  async function resendVerification() {
    if (!email) return toast.error("Enter your email first.");
    setLoading(true);
    try {
      const data = await api("/api/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      toast.success(data.message || "Verification email sent.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send verification email.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-hero px-4">
      <AnimatedBlobBackground />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md"
      >
        <Card className="glass hover-lift w-full p-8">
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.4 }}
            className="mb-6 text-center"
          >
            <div className="neu-sm mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-primary shadow-glow">
              <Sparkles className="h-5 w-5 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-bold">OrbitAvanya CRM</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "signin" ? "Sign in to your account" : "Create your CRM account"}
            </p>
          </motion.div>

          <AnimatePresence mode="wait">
            <motion.form
              key={mode}
              onSubmit={handleSubmit}
              initial={{ opacity: 0, x: mode === "signup" ? 16 : -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: mode === "signup" ? -16 : 16 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-4"
            >
              {mode === "signup" && (
                <div>
                  <Label htmlFor="name">Full name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
                </div>
              )}

              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>

              <div>
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
                {mode === "signin" && (
                  <div className="mt-2 flex justify-between gap-3 text-xs">
                    <button type="button" onClick={handleForgot} className="text-muted-foreground hover:text-foreground transition-smooth">
                      Forgot password?
                    </button>
                    <button type="button" onClick={resendVerification} className="text-muted-foreground hover:text-foreground transition-smooth">
                      Resend verification
                    </button>
                  </div>
                )}
              </div>

              <motion.div whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}>
                <Button type="submit" disabled={loading} className="w-full bg-gradient-primary shadow-glow">
                  {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
                </Button>
              </motion.div>
            </motion.form>
          </AnimatePresence>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "New to OrbitAvanya?" : "Have an account?"}{" "}
            <button
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="font-medium text-foreground underline-offset-4 hover:underline transition-smooth"
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </Card>
      </motion.div>
    </div>
  );
}