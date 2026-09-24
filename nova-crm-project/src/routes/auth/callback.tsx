import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

export const Route = createFileRoute("/auth/callback")({
  head: () => ({
    meta: [
      { title: "Verifying email — OrbitAvanya CRM" },
      {
        name: "description",
        content: "Verifying your email address.",
      },
    ],
  }),
  component: AuthCallback,
});

function AuthCallback() {
  const navigate = useNavigate();

  const [status, setStatus] = useState<
    "checking" | "success" | "error"
  >("checking");

  const [message, setMessage] = useState(
    "Verifying your email address…"
  );

  useEffect(() => {
    let mounted = true;

    async function verify() {
      try {
        /*
         * Supabase's browser client automatically processes
         * the authentication session returned in the URL.
         *
         * Wait for the resulting session.
         */
        const { data, error } = await supabase.auth.getSession();

        if (error) {
          throw error;
        }

        if (!data.session) {
          throw new Error(
            "Email verification completed, but no active session was found."
          );
        }

        if (!mounted) return;

        setStatus("success");
        setMessage("Email verified successfully. Redirecting…");

        setTimeout(() => {
          navigate({ to: "/dashboard" });
        }, 1200);
      } catch (err) {
        if (!mounted) return;

        setStatus("error");
        setMessage(
          err instanceof Error
            ? err.message
            : "Email verification failed."
        );
      }
    }

    verify();

    return () => {
      mounted = false;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="glass w-full max-w-md p-8 text-center">
        {status === "checking" && (
          <>
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />

            <h1 className="mt-5 text-2xl font-bold">
              Verifying your email
            </h1>

            <p className="mt-2 text-sm text-muted-foreground">
              Please wait while we verify your account.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />

            <h1 className="mt-5 text-2xl font-bold">
              Email verified!
            </h1>

            <p className="mt-2 text-sm text-muted-foreground">
              Your account is verified. Redirecting you to the dashboard…
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-destructive" />

            <h1 className="mt-5 text-2xl font-bold">
              Verification failed
            </h1>

            <p className="mt-2 text-sm text-muted-foreground">
              {message}
            </p>

            <button
              type="button"
              onClick={() => navigate({ to: "/auth" })}
              className="mt-6 text-sm font-medium underline"
            >
              Return to sign in
            </button>
          </>
        )}
      </Card>
    </div>
  );
}