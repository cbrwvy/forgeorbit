import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./index.css";
import App from "./App";
import { LocaleProvider } from "./i18n/react";
import { KeyboardTabOrder } from "@/components/keyboard-tab-order";
import { ConfirmProvider } from "@/components/ui/confirm";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
    <ConfirmProvider>
      <KeyboardTabOrder />
      <App />
    </ConfirmProvider>
    </LocaleProvider>
  </StrictMode>,
);
