import React from 'react';
import ReactDOM from 'react-dom/client';
import ProjectSorter from './ProjectSorter';
import './index.css';

const root = document.getElementById('root');

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ProjectSorter />
    </React.StrictMode>
  );
}
