export function agentToken(expected) {
  return (req, res, next) => {
    const t = req.headers['x-agent-token'];
    if (!t || t !== expected) return res.status(401).json({ error: 'invalid agent token' });
    next();
  };
}