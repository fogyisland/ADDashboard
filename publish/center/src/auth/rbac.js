export function requirePerm(perm) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    if (perms.includes('*') || perms.includes(perm)) return next();
    res.status(403).json({ error: 'forbidden', need: perm });
  };
}