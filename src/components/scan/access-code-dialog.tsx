"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readAccessCode, storeAccessCode } from "@/lib/client/scan-client";
import { rescan } from "@/lib/client/scan-session";

/**
 * Spec 13 `access-code`: a code field and `Continue`. The code is stored (per browser) and sent as `x-access-code` on
 * the retried scan and every later one. A stored code that the server refused is shown as not working.
 */
export function AccessCodePrompt() {
  const [code, setCode] = useState("");
  const [rejected] = useState(() => readAccessCode() !== null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = code.trim();
        if (!value) {
          inputRef.current?.focus();
          return;
        }
        storeAccessCode(value);
        rescan();
      }}
    >
      {rejected ? <p className="text-small text-danger">That code didn&apos;t work. Check it and try again.</p> : null}
      <div className="flex max-w-[400px] gap-2">
        <Input
          ref={inputRef}
          name="access-code"
          aria-label="Access code"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="flex-1"
        />
        <Button type="submit" variant="primary">
          Continue
        </Button>
      </div>
    </form>
  );
}
