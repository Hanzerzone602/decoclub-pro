// Feature flags. Defaults = pay-per-image only. Re-enable later via env.
function on(v){ return v === "1" || v === "true" || v === "on" || v === "yes"; }
function flags(){ return {
  membership: on(String(process.env.FEATURE_MEMBERSHIP||"").toLowerCase()),
  digitize:   on(String(process.env.FEATURE_DIGITIZE||"").toLowerCase()),
}; }
module.exports = { flags, membershipEnabled: () => flags().membership, digitizeEnabled: () => flags().digitize };
