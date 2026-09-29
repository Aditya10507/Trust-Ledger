// Shared activity log: memory operations AND agent (LLM) calls land here,
// so the dashboard's live feed shows everything the system actually does.
const opsLog = [];
function logOp(op, summary, extra) {
  opsLog.push({ ts: Date.now(), op, summary, ...extra });
  if (opsLog.length > 300) opsLog.shift();
}
module.exports = {
  logOp,
  getOpsLog: () => opsLog,
  clearOpsLog: () => { opsLog.length = 0; },
};
