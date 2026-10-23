// Focused runner for the upload routes. The full suite is server/runs/__tests__/index.ts.
import "../server/api/__tests__/uploads";
import { runAll } from "../server/runs/__tests__/harness";
void runAll("document uploads");
