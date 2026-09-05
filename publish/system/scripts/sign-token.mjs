import jwt from 'jsonwebtoken';
const secret = 'PDS"N3\'c]vPghJPb2Uj3<K0ey;p~AP)go\\@V*9]9%)]{Il@V';
const t = jwt.sign({ role: 'admin', permissions: ['*'] }, secret, { subject: '1', expiresIn: 120 });
console.log(t);
