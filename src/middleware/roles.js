const verifyRole = (rolesPermitidos) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "No autenticado" });

    // Admin siempre pasa
    if (req.user.rol === "Administrador") return next();

    if (rolesPermitidos.includes(req.user.rol)) {
      return next();
    }

    return res
      .status(403)
      .json({ error: "No tienes permisos para esta acción" });
  };
};

module.exports = verifyRole;
