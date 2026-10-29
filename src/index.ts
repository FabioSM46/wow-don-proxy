import { handle } from "./proxy";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, (input, init) => fetch(input, init));
  },
} satisfies ExportedHandler<Env>;
