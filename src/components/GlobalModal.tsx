import { X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGlobalModalStore, type GlobalModalAction } from '../stores/useGlobalModalStore';
import { useEscClose } from '../hooks/useEscClose';
import './GlobalModal.css';

function resolveActionClass(variant: GlobalModalAction['variant']): string {
  if (variant === 'danger') return 'btn btn-danger';
  if (variant === 'secondary') return 'btn btn-secondary';
  return 'btn btn-primary';
}

export function GlobalModal() {
  const { t } = useTranslation();
  const visible = useGlobalModalStore((state) => state.visible);
  const modal = useGlobalModalStore((state) => state.modal);
  const closeModal = useGlobalModalStore((state) => state.closeModal);

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  useEscClose(visible && !pendingActionId, closeModal);

  const handleActionClick = useCallback(async (action: GlobalModalAction) => {
    if (action.disabled || pendingActionId) return;
    const actionId = action.id || action.label;
    setActionError(null);
    setPendingActionId(actionId);
    let hasError = false;
    try {
      if (action.onClick) {
        await Promise.resolve(action.onClick());
      }
    } catch (err) {
      hasError = true;
      console.error('GlobalModal action error:', err);
      if (!action.suppressError) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
    if (!hasError && action.autoClose !== false) {
      closeModal();
    }
    setPendingActionId(null);
  }, [closeModal, pendingActionId]);

  if (!visible || !modal) return null;

  const actions = modal.actions && modal.actions.length > 0
    ? modal.actions
    : [
        {
          id: 'default-ok',
          label: t('globalModal.ok', '知道了'),
          variant: 'primary' as const,
        },
      ];

  const modalSizeClass = modal.width === 'lg'
    ? 'modal modal-lg'
    : modal.width === 'sm'
      ? 'modal global-modal-sm'
      : 'modal';

  return (
    <div className="modal-overlay global-modal-overlay">
      <div className={modalSizeClass} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{modal.title || t('globalModal.title', '提示')}</h2>
          {modal.showCloseButton !== false && (
            <button
              className="modal-close"
              onClick={closeModal}
              disabled={Boolean(pendingActionId)}
              aria-label={t('common.close', '关闭')}
            >
              <X />
            </button>
          )}
        </div>

        <div className="modal-body global-modal-body">
          {modal.description && (
            <p className="global-modal-description">{modal.description}</p>
          )}
          {modal.content}
          {actionError && (
            <div style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              color: 'var(--danger, #ef4444)',
              fontSize: 13,
            }}>
              {actionError}
            </div>
          )}
        </div>

        <div className="modal-footer global-modal-footer">
          {actions.map((action, index) => (
            <button
              key={action.id || `action-${index}`}
              className={resolveActionClass(action.variant)}
              onClick={() => { void handleActionClick(action); }}
              disabled={Boolean(pendingActionId) || action.disabled}
              title={action.label}
            >
              <span className="global-modal-action-label">
                {pendingActionId === (action.id || action.label)
                  ? t('common.processing', '处理中...')
                  : action.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
