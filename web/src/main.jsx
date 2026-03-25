import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import 'antd/dist/reset.css'
import './index.css'

const App = React.lazy(() => import('./pages/App'))
const Login = React.lazy(() => import('./pages/Login'))
const Sites = React.lazy(() => import('./pages/Sites'))
const SiteDetail = React.lazy(() => import('./pages/SiteDetail'))

function RequireAuth({ children }) {
  const token = localStorage.getItem('token')
  if (!token) return <Navigate to="/login" replace />
  return children
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <React.Suspense fallback={<div style={{ padding: 32, textAlign: 'center', color: '#666' }}>页面加载中...</div>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><App /></RequireAuth>}>
            <Route index element={<Sites />} />
            <Route path="sites/:id" element={<SiteDetail />} />
          </Route>
        </Routes>
      </React.Suspense>
    </BrowserRouter>
  </React.StrictMode>
)
