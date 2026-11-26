import React from 'react';

export const ANCORA_LOGO_SRC =
  '/assets/aistudio/AaH44QuRnv48eXxc56n5GQ-AaH44QuRl6sAKj6e8DLraA_f77fc150.jpg';

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  systemName?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 'md',
  showText = true,
  systemName = 'Âncora SMS',
}) => {
  const imgBoxClass =
    size === 'lg'
      ? 'w-44 h-44 sm:w-52 sm:h-52'
      : size === 'sm'
      ? 'w-9 h-9'
      : 'w-11 h-11';

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div
        className={`${imgBoxClass} bg-white rounded-lg border border-slate-200/80 dark:border-slate-700 p-1 flex items-center justify-center shrink-0 overflow-hidden`}
      >
        <img
          src={ANCORA_LOGO_SRC}
          alt="Logotipo Âncora SMS — Stock Management System"
          className="w-full h-full object-contain"
        />
      </div>
      {showText && (
        <div className="min-w-0">
          <p className="text-sm sm:text-base font-display font-bold text-green-800 dark:text-white leading-tight whitespace-nowrap truncate">
            {systemName}
          </p>
          <p className="text-[11px] font-medium text-green-700 dark:text-green-400 leading-tight whitespace-nowrap truncate">
            Stock Management System
          </p>
        </div>
      )}
    </div>
  );
};
