import { getOAuthResourceUrl, probeOAuthReadiness } from "./oauth.js";
export function registerHttpDiagnosticsRoutes(app, config, authState, corsMiddleware) {
    app.get("/healthz", corsMiddleware, (_req, res) => {
        res.json({
            status: "ok",
            authMode: config.authMode,
            protected: config.authMode === "oauth" || Boolean(authState.httpAuthToken),
        });
    });
    app.get("/readyz", corsMiddleware, async (_req, res) => {
        if (config.authMode === "oauth" && authState.oauthConfig) {
            try {
                const readiness = await probeOAuthReadiness(authState.oauthConfig);
                res.json({
                    status: "ok",
                    authMode: "oauth",
                    issuer: readiness.issuer,
                    jwksUri: readiness.jwksUri,
                    resource: getOAuthResourceUrl(authState.oauthConfig.publicBaseUrl),
                });
                return;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "OAuth readiness check failed.";
                res.status(503).json({
                    status: "not_ready",
                    authMode: "oauth",
                    error: message,
                });
                return;
            }
        }
        res.json({
            status: "ok",
            authMode: config.authMode,
        });
    });
}
