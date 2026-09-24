import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/auth";

export const Route = createFileRoute("/verify-email")({
  head: () => ({ meta: [{ title: "Verify email — OrbitAvanya CRM" }] }),
  component: VerifyEmail,
});

function VerifyEmail() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("Verifying your email…");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setMessage("Verification link is missing.");
      return;
    }

    api(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => {
        setMessage("Email verified successfully. You can now sign in.");
        setTimeout(() => { window.location.href = "/auth?verified=1"; }, 1000);
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : "Verification failed."));
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="glass w-full max-w-md p-8 text-center">
        <h1 className="text-2xl font-bold">Email verification</h1>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        <Button className="mt-6" onClick={() => navigate({ to: "/auth" })}>Go to sign in</Button>
      </Card>
    </div>
  );
}
