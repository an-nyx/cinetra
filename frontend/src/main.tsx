import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./assets/css/main.css";
import { installServiceWorker } from "./lib/service-worker";

// Push-only service worker (no caching); registering it never asks for notification permission.
installServiceWorker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
