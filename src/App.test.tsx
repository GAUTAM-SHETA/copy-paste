import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders snippet manager shell', () => {
  render(<App />);
  expect(screen.getByText(/copy paste/i)).toBeInTheDocument();
  expect(screen.getAllByText(/root selected/i).length).toBeGreaterThan(0);
});
