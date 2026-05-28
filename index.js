const app = require('./api/proxy.js');
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`IPTV Proxy running on port ${port}`);
});
