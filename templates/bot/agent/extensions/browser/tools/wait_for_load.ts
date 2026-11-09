import { wait_for_load } from "@agent-browser/eve/tools";
import { lazyTool } from "../../../lib/lazy-tools";

export default lazyTool("browser", wait_for_load);
