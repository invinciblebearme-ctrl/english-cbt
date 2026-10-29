import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import StudentApp from './student/StudentApp';
import { Spinner } from './components/ui';

// 관리자 화면은 별도 묶음으로 분리해 학생 화면을 가볍게 유지
const AdminApp = lazy(() => import('./admin/AdminApp'));

export default function App() {
  return (
    <Suspense fallback={<Spinner full />}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/*" element={<StudentApp />} />
      </Routes>
    </Suspense>
  );
}
