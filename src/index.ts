import { handle } from "./proxy";

export { DailyBudget } from "./daily-budget";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, (input, init) => fetch(input, init));
  },
} satisfies ExportedHandler<Env>;
