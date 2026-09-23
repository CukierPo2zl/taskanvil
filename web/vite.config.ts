import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const agentPort = process.env.AGENT_PORT ?? "3456";

export default defineConfig({
	plugins: [react()],
	base: "/ui/",
	server: {
		port: 5173,
		proxy: {
			"/api": `http://127.0.0.1:${agentPort}`,
		},
	},
});
