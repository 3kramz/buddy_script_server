const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ message: 'access denied' });
  }

  const token = authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'authorization denied' });
  }

  try {
    const SECRET_KEY = process.env.SECRET_KEY || "***REDACTED***";
    
    // Verify token
    const decoded = jwt.verify(token, SECRET_KEY);
    
    // Attach user payload to the request object
    req.user = decoded;
    
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

module.exports = authMiddleware;
