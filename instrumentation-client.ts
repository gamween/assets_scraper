import { initBotId } from "botid/client/core";

initBotId({ protect: [{ path: "/api/scan", method: "POST" }] });
