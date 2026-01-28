const verifyRole = (rolesPermitidos) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "No autenticado" });

    const userRol = req.user.rol ? req.user.rol.toLowerCase() : "";

    // Admin siempre pasa
    if (userRol === "administrador") return next();

    if (rolesPermitidos.some((role) => role.toLowerCase() === userRol)) {
      return next();
    }

    return res
      .status(403)
      .json({ error: "No tienes permisos para esta acción" });
  };
};

module.exports = verifyRole;
