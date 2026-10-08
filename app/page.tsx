import Carpool from './carpool';
import LoginGate from './login-gate';
export default function Home(){return <LoginGate>{process.env.NEXT_PUBLIC_PREVIEW_MODE==='true'&&<div className="preview-banner">Review demo · Real Supabase login · Isolated test rides · No notifications sent</div>}<Carpool/></LoginGate>;}
