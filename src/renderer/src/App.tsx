import { Box } from '@mui/material';
import Versions from './components/Versions'
import { useEffect, useState } from 'react';
// import electronLogo from './assets/electron.svg'

function App(): React.JSX.Element {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')
  // const ipcPHandle = (): void => window.electron.ipcRenderer.send('proxy')
  const [enableProxy, setEnableProxy] = useState<boolean>();


  useEffect(() => {
    const getDns = async () => {

      // Proxy
      window.api.getProxy().then((data) => {
        console.log("proxy: ", data)
        if (data === true || data === false) setEnableProxy(data)
      });
    };

    // بار اول بلافاصله اجرا شود
    getDns();

    // هر ۳ ثانیه اجرا شود
    const interval = setInterval(getDns, 3000);

    // پاک کردن تایمر
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <Box>

        proxy staus: {enableProxy ? 'on' : 'off'} <br />
      </Box>
      <div className="action">
        <a target="_blank" rel="noreferrer" onClick={() => {
          window.api.getProxy().then((data) => {
            console.log("proxy: ", data)
            if (data === true || data === false) setEnableProxy(data)
          });
          window.api.getProxyServer().then((data) => console.log("getProxyServer: ", data));
          window.api.getVpn().then((data) => { });
          window.api.getDns().then((data) => console.log("dns", data));
        }}>
          Send IPC
        </a>
      </div>
      <Versions />
    </>
  )
}

export default App
