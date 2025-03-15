import 'jquery'
import 'bootstrap'
import { lockScroll, unlockScroll } from 'spree/core/helpers/scroll_lock'


const initTooltips = () => {
  $('.with-tip').each(function() {
    $(this).tooltip()
  })

  $('.with-tip').on('show.bs.tooltip', function(event) {
    if (('ontouchstart' in window)) {
      event.preventDefault()
    }
  })
}

const removeTooltips = () => {
  $('.with-tip').each(function() {
    $(this).tooltip('dispose')
  })
}

const resetDialogModal = () => {
  const modalElement = document.getElementById('dialog_modal')
  const modalTitle = modalElement ? modalElement.querySelector('.modal-title') : null
  const modalBody = modalElement ? modalElement.querySelector('.modal-body') : null
  if (modalBody) {
    modalBody.innerHTML = '<div class="spinner-border text-light mx-auto my-5" role="status"><span class="sr-only">Loading...</span></div>'
  }
  if (modalTitle) {
    modalTitle.innerHTML = 'Loading...'
  }
}

$('.modal').on('show.bs.modal', lockScroll)
$('.modal').on('hide.bs.modal', unlockScroll)
$('.modal').on('hidden.bs.modal	', resetDialogModal)

document.addEventListener("turbo:click", removeTooltips)
document.addEventListener("turbo:load", initTooltips)
document.addEventListener('turbo:frame-render', initTooltips)
