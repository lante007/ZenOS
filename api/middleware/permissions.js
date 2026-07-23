'use strict';

const ROLES = {
  ORGANISATION_LEAD: 1,
  EVIDENCE_ANALYST: 2,
  COMMUNICATIONS: 3,
  CEO_EXEC: 4,
};

function requireRoles(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role for this action' });
    }
    next();
  };
}

function assertNoBoardAccess(req, res, next) {
  const role = req.user?.role;
  if (role === 'BOARD' || role === 'TRUSTEE' || role === 'BOARD_MEMBER') {
    return res.status(403).json({ error: 'Board and trustee users do not have EvidenceOS access' });
  }
  next();
}

module.exports = { ROLES, requireRoles, assertNoBoardAccess };
