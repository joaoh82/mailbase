// Phase 0: log-only inbound handler. Phase 1 adds parse → resolve → store.
export default {
  async email(message, _env, _ctx) {
    console.log(
      `Inbound email: from=${message.from} to=${message.to} size=${message.rawSize}`,
    );
  },
} satisfies ExportedHandler<Env>;
