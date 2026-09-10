import { createFileRoute } from "@tanstack/react-router";
import App from "../renderer/app";

export const Route = createFileRoute("/")({ component: App });
